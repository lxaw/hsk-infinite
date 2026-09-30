"""Blind-solve check for ambiguity-prone parts.

    blind.py dump LEVEL PART [PART ...] [--ids ID ...]  -> scratch/blind_LEVEL.json (no answer keys)
    blind.py diff LEVEL answers.json                    -> compare an independent solver's answers

The dump lists each question with lettered options. The solver writes
{"<qid>": {"answer": "B", "also_ok": ["C"], "note": "..."}} where qid is the dump's "qid".
"also_ok" lists any other option the solver thinks is also defensible. Every mismatch or
also_ok entry needs a human look (rewrite the item or confirm the key).
"""
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LET = "ABCDEFGH"


def units(level, part):
    return json.loads((ROOT / "bank" / level / f"{part}.json").read_text())


def dump(level, parts, ids):
    out = []
    for part in parts:
        for u in units(level, part):
            if ids and u["id"] not in ids:
                continue
            ctx = {k: u[k] for k in ("passage", "dialogue", "title") if k in u}
            if "questions" in u:
                for k, q in enumerate(u["questions"]):
                    out.append({"qid": f"{u['id']}#{k}", **ctx, "question": q.get("question", f"blank [{k + 1}]"),
                                "options": {LET[i]: o for i, o in enumerate(q["options"])}})
            elif "options" in u:
                default = ("Choose the best option (fill every blank in the passage)." if "[1]" in u.get("passage", "")
                           else "Which option agrees with the passage (与这段话内容一致的是)?")
                task = "Which sentence contains an error (病句)?" if part == "R1" and level == "hsk6" else u.get("question", default)
                out.append({"qid": u["id"], **ctx, "question": task, "options": {LET[i]: o for i, o in enumerate(u["options"])}})
            elif "sentences" in u:  # insertion: one question per blank, same sentence list
                for k in range(len(u["answers"])):
                    out.append({"qid": f"{u['id']}#{k}", "passage": u["passage"], "question": f"Which sentence goes in blank [{k + 1}]? (each sentence is used once)",
                                "options": {LET[i]: s for i, s in enumerate(u["sentences"])}})
            elif "bank" in u:  # HSK 4 word bank
                for k, it in enumerate(u["items"]):
                    out.append({"qid": f"{u['id']}#{k}", "passage": it["text"], "question": "Which word fills （ ）? (each word used once in the block; the example uses one)",
                                "options": {LET[i]: w for i, w in enumerate(u["bank"]) if i != u["example"]["answer"]}})
            elif "A" in u:  # ordering
                out.append({"qid": u["id"], "question": "Put A, B, C in the only natural order", "options": {k: u[k] for k in "ABC"}})
    # Shuffle option letters so answer position gives nothing away; keep the mapping private.
    mapping = {}
    for q in out:
        if q["question"].startswith("Put A, B, C"):
            continue
        orig = list(q["options"].items())
        random.shuffle(orig)
        q["options"] = {LET[i]: text for i, (_, text) in enumerate(orig)}
        mapping[q["qid"]] = {LET[i]: o for i, (o, _) in enumerate(orig)}
    dest = ROOT / "scratch" / f"blind_{level}.json"
    dest.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    (ROOT / "scratch" / f"blind_{level}_map.json").write_text(json.dumps(mapping))
    print(f"{len(out)} questions -> {dest}")


def key(level, qid):
    uid, _, k = qid.partition("#")
    part = uid.rsplit("-", 1)[0]
    u = next(x for x in units(level, part) if x["id"] == uid)
    if "questions" in u:
        return LET[u["questions"][int(k)]["answer"]]
    if "options" in u:
        return LET[u["answer"]]
    if "sentences" in u:
        return LET[u["answers"][int(k)]]
    if "bank" in u:
        return LET[u["items"][int(k)]["answer"]]
    return u["answer"]


def diff(level, path):
    ans = json.loads(Path(path).read_text())
    mapping = json.loads((ROOT / "scratch" / f"blind_{level}_map.json").read_text())
    bad = 0
    for qid, a in ans.items():
        m = mapping.get(qid, {})
        a = {**a, "answer": m.get(a["answer"], a["answer"]), "also_ok": [m.get(x, x) for x in a.get("also_ok", [])]}
        k = key(level, qid)
        flags = []
        if a["answer"] != k:
            flags.append(f"solver {a['answer']} ≠ key {k}")
        if a.get("also_ok"):
            flags.append(f"also defensible: {a['also_ok']}")
        if flags:
            bad += 1
            print(f"{qid}: {'; '.join(flags)}  — {a.get('note', '')}")
    print(f"{len(ans)} checked, {bad} need a look")


if __name__ == "__main__":
    cmd, level = sys.argv[1], sys.argv[2]
    if cmd == "dump":
        rest = sys.argv[3:]
        ids = set(rest[rest.index("--ids") + 1:]) if "--ids" in rest else set()
        parts = rest[:rest.index("--ids")] if "--ids" in rest else rest
        dump(level, parts, ids)
    else:
        diff(level, sys.argv[3])
