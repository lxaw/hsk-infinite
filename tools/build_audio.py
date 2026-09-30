"""Generate listening audio with edge-tts for one level.

Per unit (site/audio/<level>/<id>.mp3):
  tf         passage (speaker) or dialogue + statement (narrator)
  mcq        dialogue or passage + "问：" question (narrator; skipped when the part has noQuestion)
  mcq_group  passage or dialogue only; questions go to <id>_q<k>.mp3 (narrator)
Fixed prompts (site/audio/<level>/fixed/): intro, part intros, question numbers, "第X到Y题…" ranges.

Clips are cached by a hash of their text + voice settings (site/audio/<level>/manifest.json).
Voices: tools/audio_config.json (f, m, n, plus f2/m2 for a second woman/man).

    .venv/bin/python tools/build_audio.py --level hsk5 [--force] [--only ID ...]
"""
import asyncio
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import edge_tts

ROOT = Path(__file__).resolve().parent.parent
VOICE = json.loads((ROOT / "tools/audio_config.json").read_text())
CONCURRENCY = 6
args = sys.argv[1:]
LEVEL = args[args.index("--level") + 1] if "--level" in args else "hsk4"
CFG = json.loads((ROOT / "levels" / f"{LEVEL}.json").read_text())
OUT = ROOT / "site/audio" / LEVEL
MANIFEST = OUT / "manifest.json"


def listening():
    return next((s for s in CFG["sections"] if s["key"] == "listening"), None)


def fixed_prompts():
    sec = listening()
    if not sec:
        return {}
    out = {"intro": sec["intro"], "end": "听力考试现在结束。"}
    for n in range(sec["first"], sec["first"] + sec["count"]):
        out[f"num{n}"] = f"第{n}题"
    q = sec["first"]
    for p in sec["parts"]:
        if p.get("audioIntro"):
            out[f"intro_{p['group']}"] = p["audioIntro"]
        size = p.get("questions") or p["units"] * (p.get("questionsPerUnit") or [1])[0]
        if p["type"] == "mcq_group":
            for a in range(q, q + size):
                for k in p["questionsPerUnit"]:
                    b = a + k - 1
                    if b < q + size:
                        out[f"range_{p['id']}_{a}_{b}"] = p["rangeIntro"].format(a=a, b=b)
        q += size
    return out


def body(u):
    return [(d["s"], d["t"]) for d in u["dialogue"]] if "dialogue" in u else [(u["speaker"], u["passage"])]


def segments(part, u):
    i = u["id"]
    if part["type"] == "tf":
        return {i: body(u) + [("n", u["statement"])]}
    if part["type"] == "mcq":
        return {i: body(u) + ([] if part.get("noQuestion") else [("n", "问：" + u["question"])])}
    if part["type"] == "mcq_group":
        out = {i: body(u)}
        for k, q in enumerate(u["questions"]):
            out[f"{i}_q{k}"] = [("n", q["question"])]
        return out
    return {}


def key(segs):
    blob = json.dumps([segs, VOICE], ensure_ascii=False, sort_keys=True)
    return hashlib.sha1(blob.encode()).hexdigest()[:16]


async def tts(text, speaker, path, sem):
    err = None
    for attempt in range(5):
        try:
            async with sem:
                await edge_tts.Communicate(text, VOICE["voices"][speaker], rate=VOICE["rate"]).save(str(path))
            if path.stat().st_size > 1000:
                return
        except Exception as e:  # network hiccups
            err = e
        await asyncio.sleep(2 * (attempt + 1))
    raise RuntimeError(f"TTS failed for {text[:20]}: {err or 'empty file'}")


def concat(parts, gaps_ms, dest):
    inputs, labels, idx = [], [], 0
    for k, p in enumerate(parts):
        inputs += ["-i", str(p)]
        labels.append(f"[{idx}:a]"); idx += 1
        if k < len(parts) - 1:
            inputs += ["-f", "lavfi", "-t", f"{gaps_ms[k] / 1000:.2f}", "-i", "anullsrc=r=24000:cl=mono"]
            labels.append(f"[{idx}:a]"); idx += 1
    flt = "".join(labels) + f"concat=n={len(labels)}:v=0:a=1[out]"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *inputs, "-filter_complex", flt,
                    "-map", "[out]", "-ar", "24000", "-ac", "1", "-b:a", "64k", str(dest)], check=True)


async def build_clip(stem, segs, dest, sem, tmp):
    paths = [Path(tmp) / f"{stem.replace('/', '_')}_{k}.mp3" for k in range(len(segs))]
    await asyncio.gather(*(tts(t, s, p, sem) for (s, t), p in zip(segs, paths)))
    gaps = [VOICE["gap_question_ms"] if segs[k + 1][0] == "n" else VOICE["gap_turn_ms"] for k in range(len(segs) - 1)]
    concat(paths, gaps, dest)


async def main():
    force = "--force" in args
    only = set(args[args.index("--only") + 1:]) if "--only" in args else None
    (OUT / "fixed").mkdir(parents=True, exist_ok=True)
    manifest = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    jobs = [(f"fixed/{k}", [("n", t)]) for k, t in fixed_prompts().items()]
    sec = listening()
    for part in (sec["parts"] if sec else []):
        f = ROOT / "bank" / LEVEL / f"{part['id']}.json"
        if not f.exists():
            continue
        for u in json.loads(f.read_text()):
            if only and u["id"] not in only:
                continue
            jobs += list(segments(part, u).items())
    todo = [(s, g) for s, g in jobs if force or manifest.get(s) != key(g) or not (OUT / f"{s}.mp3").exists()]
    print(f"{LEVEL}: {len(jobs)} clips, {len(todo)} to generate")
    sem = asyncio.Semaphore(CONCURRENCY)
    with tempfile.TemporaryDirectory() as tmp:
        done = 0
        for b0 in range(0, len(todo), 20):
            batch = todo[b0:b0 + 20]
            res = await asyncio.gather(*(build_clip(s, g, OUT / f"{s}.mp3", sem, tmp) for s, g in batch), return_exceptions=True)
            for (s, g), r in zip(batch, res):
                if isinstance(r, Exception):
                    print("  FAILED", s, r)
                else:
                    manifest[s] = key(g); done += 1
            MANIFEST.write_text(json.dumps(manifest, indent=0, sort_keys=True))
            print(f"  {done}/{len(todo)}")
    print("done")


if __name__ == "__main__":
    asyncio.run(main())
