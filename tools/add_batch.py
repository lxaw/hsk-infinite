"""Append a batch of new units to a bank part, assigning ids.

    .venv/bin/python tools/add_batch.py LEVEL PART batch.json

batch.json is a JSON array of units without "id"; they are appended to bank/LEVEL/PART.json
with the next free ids (PART-0001 ...). Run tools/validate.py --level LEVEL afterwards.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    level, part, src = sys.argv[1], sys.argv[2], Path(sys.argv[3])
    dest = ROOT / "bank" / level / f"{part}.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    units = json.loads(dest.read_text()) if dest.exists() else []
    n = max((int(u["id"].rsplit("-", 1)[1]) for u in units), default=0)
    for u in json.loads(src.read_text()):
        u.pop("id", None)
        n += 1
        units.append({"id": f"{part}-{n:04d}", **u})
    dest.write_text("[\n" + ",\n".join(json.dumps(u, ensure_ascii=False) for u in units) + "\n]\n")
    print(f"{level} {part}: now {len(units)} units")


if __name__ == "__main__":
    main()
