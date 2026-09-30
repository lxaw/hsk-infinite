"""Apply exact text replacements to a bank part:  fix.py LEVEL PART '{"old": "new", ...}'"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
level, part, reps = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
p = ROOT / "bank" / level / f"{part}.json"
js = json.dumps(json.loads(p.read_text()), ensure_ascii=False)
for a, b in reps.items():
    if a not in js:
        print("NOT FOUND:", a)
    js = js.replace(a, b)
units = json.loads(js)
p.write_text("[\n" + ",\n".join(json.dumps(u, ensure_ascii=False) for u in units) + "\n]\n")
