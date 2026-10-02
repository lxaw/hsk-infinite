"""Bank statistics for the README: units, questions, papers before a repeat, distinct possible papers.

    python3 tools/stats.py            # Markdown table

"Distinct papers" counts the different sets of items a full paper can be made of (the product,
over the parts, of the ways to choose that part's units). It ignores the order of items and the
reshuffled answer options, so the number of different-looking papers is far larger still.
"""
import json
import math
from itertools import product
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def n_questions(part, u):
    t = part["type"]
    if t == "mcq_group":
        return len(u["questions"])
    if t == "wordbank":
        return len(u["items"])
    if t == "insert":
        return len(u["answers"])
    return 1


def ways(part, units):
    """Number of different unit sets one paper can draw for this part, and papers before a repeat."""
    if part.get("kinds"):  # one unit of each kind
        per = [sum(u.get("kind") == k for u in units) for k in part["kinds"]]
        return math.prod(per), min(per)
    if not part.get("questions"):
        return math.comb(len(units), part["units"]), len(units) // part["units"]
    # an exact question total filled with groups of several sizes
    sizes = sorted(set(part["questionsPerUnit"]))
    have = {s: sum(n_questions(part, u) == s for u in units) for s in sizes}
    total, mixes = 0, []
    for counts in product(*[range(have[s] + 1) for s in sizes]):
        if sum(c * s for c, s in zip(counts, sizes)) == part["questions"]:
            total += math.prod(math.comb(have[s], c) for c, s in zip(counts, sizes))
            mixes.append(counts)
    papers = sum(n_questions(part, u) for u in units) // part["questions"]
    return total, papers


def level_stats(cfg):
    units = questions = 0
    combos, papers = 1, None
    for sec in cfg["sections"]:
        for part in sec["parts"]:
            bank = json.loads((ROOT / "bank" / cfg["level"] / f"{part['id']}.json").read_text())
            units += len(bank)
            questions += sum(n_questions(part, u) for u in bank)
            w, p = ways(part, bank)
            combos *= w
            papers = p if papers is None else min(papers, p)
    speaking = 0
    for part in cfg.get("speaking", {}).get("parts", []):
        bank = json.loads((ROOT / "bank" / cfg["level"] / f"{part['id']}.json").read_text())
        speaking += sum(len(u.get("questions", [1])) for u in bank)
    per_paper = sum(s["count"] for s in cfg["sections"])
    return dict(name=cfg["short"], per_paper=per_paper, units=units, questions=questions, speaking=speaking,
                papers=papers, combos=combos)


def power(n):
    return f"≈ 10^{len(str(n)) - 1}"


def main():
    cfgs = sorted((json.loads(f.read_text()) for f in (ROOT / "levels").glob("*.json")), key=lambda c: (c.get("order", 0), c["level"]))
    rows = [level_stats(c) for c in cfgs]
    print("| Level | Questions per paper | Questions in the bank | Speaking tasks | Papers before any repeat | Distinct possible papers |")
    print("|---|---:|---:|---:|---:|---:|")
    for r in rows:
        print(f"| {r['name']} | {r['per_paper']} | {r['questions']:,} | {r['speaking'] or '—'} | {r['papers']} | {power(r['combos'])} |")
    print(f"| **Total** | | **{sum(r['questions'] for r in rows):,}** | **{sum(r['speaking'] for r in rows)}** | **{sum(r['papers'] for r in rows)}** | |")


if __name__ == "__main__":
    main()
