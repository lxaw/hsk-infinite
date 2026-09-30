"""Build site/vocab.json: {word: [hsk_level, pinyin, gloss]} for the HSK 2.0 word lists 1-6.

Levels come from data/wordlists/L1-L6.txt. Pinyin and English glosses come from the
complete-hsk-vocabulary data in ../shared/ref/<n>.json (meanings from CC-CEDICT, CC BY-SA 4.0);
the ~200 words missing there use data/gloss_extra.tsv. Also writes site/vocab_v3.json for the
HSK 3.0 (2025) lists (data/wordlists_v3), with CC-CEDICT (data/cedict.txt, optional) for the rest.
The site uses this file to tag missed words and export them to Anki.

    .venv/bin/python tools/build_vocab.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REF = ROOT.parent / "shared" / "ref"

ref = {}
for n in range(1, 7):
    f = REF / f"{n}.json"
    if f.exists():
        for e in json.loads(f.read_text(encoding="utf-8")):
            ref.setdefault(e["simplified"], e)

syl = {e["w"]: e for e in json.loads((ROOT / "data" / "syllabus_hsk4.json").read_text(encoding="utf-8"))["words"]}
try:
    from pypinyin import lazy_pinyin, Style
    to_pinyin = lambda w: " ".join(lazy_pinyin(w, style=Style.TONE))
except ImportError:  # run with .venv/bin/python for pinyin on the few words missing from ../shared/ref
    to_pinyin = lambda w: ""

extra = dict(l.split("\t", 1) for l in (ROOT / "data" / "gloss_extra.tsv").read_text(encoding="utf-8").splitlines() if l and not l.startswith("#"))

vocab, missing = {}, 0
for lvl in range(1, 7):
    for w in (ROOT / "data" / "wordlists" / f"L{lvl}.txt").read_text(encoding="utf-8-sig").split():
        if w in vocab:
            continue
        e = ref.get(w)
        if e:
            # Put proper-noun readings (capitalised pinyin, e.g. 时代 Shí dài) after the common ones.
            forms = sorted(e["forms"], key=lambda f: f["transcriptions"]["pinyin"][:1].isupper())
            if not forms[0]["transcriptions"]["pinyin"][:1].isupper():
                forms = [f for f in forms if not f["transcriptions"]["pinyin"][:1].isupper()]
            pinyin = " / ".join(dict.fromkeys(f["transcriptions"]["pinyin"] for f in forms[:2]))
            meanings = [m for f in forms[:2] for m in f["meanings"] if not m.startswith(("variant of", "old variant", "surname "))]
            gloss = "; ".join((meanings or [m for f in forms for m in f["meanings"]])[:3])
        elif w in syl and syl[w].get("gloss"):
            pinyin, gloss = syl[w].get("pinyin", ""), syl[w]["gloss"]
        else:
            pinyin, gloss, missing = to_pinyin(w), "", missing + 1
        if not gloss and w in extra:
            gloss, missing = extra[w].strip(), missing - 1
        vocab[w] = [lvl, pinyin, gloss]

out = ROOT / "site" / "vocab.json"
out.write_text(json.dumps(vocab, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"{len(vocab)} words -> {out} ({missing} without a gloss)")

# CC-CEDICT (optional, gitignored: data/cedict.txt from mdbg.net) fills meanings the sources above lack.
cedict = {}
cf = ROOT / "data" / "cedict.txt"
if cf.exists():
    import re
    for line in cf.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^\S+ (\S+) \[([^\]]+)\] /(.*)/$", line)
        if not m or m.group(2)[:1].isupper():  # skip proper-noun readings
            continue
        senses = [x for x in m.group(3).split("/") if not x.startswith(("variant of", "old variant", "CL:", "see ", "used in"))]
        if senses and m.group(1) not in cedict:
            cedict[m.group(1)] = "; ".join(senses[:3])

# HSK 3.0 (2025) lists, levels 1-6 and 7-9 (tagged 7): level and pinyin from the syllabus; meanings as above.
v3, missing = {}, []
for line in (ROOT / "data" / "wordlists_v3" / "words.tsv").read_text(encoding="utf-8").splitlines():
    _, lvl, w, pinyin, _ = (line.split("\t") + [""] * 5)[:5]
    if lvl not in ("1", "2", "3", "4", "5", "6", "7-9") or w in v3:
        continue
    lvl = "7" if lvl == "7-9" else lvl  # levels 7-9 share one list
    gloss = vocab[w][2] if w in vocab else ""
    if not gloss and w in ref:
        gloss = "; ".join(m for f in ref[w]["forms"][:2] for m in f["meanings"])[:120]
    if not gloss:
        gloss = extra.get(w, "").strip() or cedict.get(w, "")
    if not gloss:
        missing.append(w)
    v3[w] = [int(lvl), pinyin, gloss]
out = ROOT / "site" / "vocab_v3.json"
out.write_text(json.dumps(v3, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"{len(v3)} words (HSK 3.0) -> {out} ({len(missing)} without a gloss)")
if missing:
    print("  no gloss:", " ".join(missing))
