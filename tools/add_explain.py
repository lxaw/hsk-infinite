"""Merge answer explanations into a bank part, or report how many are still missing.

    .venv/bin/python tools/add_explain.py LEVEL PART explain.json    # merge
    .venv/bin/python tools/add_explain.py LEVEL [PART]               # coverage report

explain.json is an object keyed by unit id, or by "unit id#k" for the k-th (0-based) question of a
group, word-bank item or insertion blank:  {"R2-0001": "...", "R3b-0004#1": "..."}.
Explanations must not name option letters (options are reshuffled on every paper): quote the word or
sentence instead. In an `order` item write {A} {B} {C} for the three sentences; the site shows the
letters that paper displayed.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def slots(ptype, u):
    """(key, holder, field, index) for every explanation an auto-scored unit can carry."""
    if ptype == "mcq_group":
        return [(f"{u['id']}#{k}", q, "explain", None) for k, q in enumerate(u["questions"])]
    if ptype == "wordbank":
        return [(f"{u['id']}#{k}", it, "explain", None) for k, it in enumerate(u["items"])]
    if ptype == "insert":
        u.setdefault("explains", [""] * len(u["answers"]))
        return [(f"{u['id']}#{k}", u, "explains", k) for k in range(len(u["answers"]))]
    return [(u["id"], u, "explain", None)]


def get(holder, field, idx):
    return holder.get(field) if idx is None else holder[field][idx]


def main():
    level = sys.argv[1]
    cfg = json.loads((ROOT / "levels" / f"{level}.json").read_text())
    types = {p["id"]: p["type"] for s in cfg["sections"] for p in s["parts"] if p["type"] != "free"}
    src = Path(sys.argv[3]) if len(sys.argv) > 3 else None
    new = json.loads(src.read_text()) if src else {}
    done = total = 0
    for part in ([sys.argv[2]] if len(sys.argv) > 2 else types):
        dest = ROOT / "bank" / level / f"{part}.json"
        units = json.loads(dest.read_text())
        have = n = 0
        for u in units:
            had = "explains" in u
            for key, holder, field, idx in slots(types[part], u):
                text = new.pop(key, None)
                if text is not None:
                    if idx is None:
                        holder[field] = text.strip()
                    else:
                        holder[field][idx] = text.strip()
                n += 1
                have += bool(get(holder, field, idx))
            if not had and "explains" in u and not any(u["explains"]):
                del u["explains"]
        if src:
            dest.write_text("[\n" + ",\n".join(json.dumps(u, ensure_ascii=False) for u in units) + "\n]\n")
        print(f"{level} {part:5} {have:4}/{n:4} explained")
        done, total = done + have, total + n
    for key in new:
        print("NOT FOUND:", key)
    if len(sys.argv) <= 2:
        print(f"{level} total {done}/{total}")


if __name__ == "__main__":
    main()
