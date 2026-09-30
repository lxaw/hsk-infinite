"""Local server for the HSK practice exams (HSK 4, 5, 6).

    .venv/bin/python server.py            # then open http://localhost:8004

Serves site/ and a small JSON API:
  GET  /api/levels                 level configs (levels/*.json) + bank sizes
  GET  /api/bank/<level>           all bank units for a level (read live from bank/<level>/*.json)
  GET  /api/attempts               past attempts (all levels), newest first, with Claude grades merged in
  GET  /api/attempts/<id>          one attempt
  POST /api/attempts               save a finished attempt; if it has free-writing answers, also writes
                                   submissions/pending/<id>.json for Claude Code to grade
Grades written by Claude to submissions/graded/<id>.json are picked up automatically.
"""
import json
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SITE, BANK, LEVELS = ROOT / "site", ROOT / "bank", ROOT / "levels"
SUB = ROOT / "submissions"
ATTEMPTS, PENDING, GRADED = SUB / "attempts", SUB / "pending", SUB / "graded"
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def levels():
    cfgs = [json.loads(p.read_text()) for p in LEVELS.glob("*.json")]
    return {c["level"]: c for c in sorted(cfgs, key=lambda c: (c.get("order", 0), c["level"]))}


def parts_of(cfg):
    return [pt for s in cfg["sections"] for pt in s["parts"]]


def load_bank(level):
    d = BANK / level
    return {p.stem: json.loads(p.read_text()) for p in sorted(d.glob("*.json"))} if d.is_dir() else {}


def with_grade(att):
    g = GRADED / f"{att['id']}.json"
    if g.exists():
        att["claudeGrade"] = json.loads(g.read_text())
    return att


def grading_request(att):
    """Self-contained request for Claude: everything needed to grade without other files."""
    cfg = levels().get(att.get("level", "hsk4"))
    if not cfg:
        return None
    free = {pt["id"]: pt for pt in parts_of(cfg) if pt["type"] == "free"}
    qs = [q for q in att.get("questions", []) if q["part"] in free]
    if not qs:
        return None
    bank = load_bank(cfg["level"])
    items = []
    for q in qs:
        pt = free[q["part"]]
        u = next((x for x in bank.get(q["part"], []) if x["id"] == q["unitId"]), {})
        it = {"qnum": q["qnum"], "unitId": q["unitId"], "kind": pt["kind"], "max": pt["points"],
              "rubric": pt["rubric"], "response": q.get("response") or "",
              "responseChars": len(re.sub(r"\s", "", q.get("response") or ""))}  # incl. punctuation, like answer-sheet squares
        if pt.get("targetChars"):
            it["targetChars"] = pt["targetChars"]
        if pt.get("prompt"):
            it["prompt"] = pt["prompt"]
        for k in ("word", "words", "task", "source", "scene", "scenes", "chart", "title", "story", "models", "model"):
            if k in u:
                it[k] = u[k]
        if pt["kind"] in ("picture_sentence", "essay_picture", "picture_story", "chart_essay"):
            it["image"] = f"site/images/{cfg['level']}/{q['unitId']}.jpg"
        items.append(it)
    return {
        "attemptId": att["id"], "level": cfg["level"], "finishedAt": att.get("finishedAt"),
        "instructions": "Grade each item against its own rubric (look at the image first when there is one). "
                        "Write submissions/graded/<attemptId>.json as described in CLAUDE.md.",
        "items": items,
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(SITE), **kw)

    def log_message(self, fmt, *args):
        if args and "/api/" in str(args[0]):
            super().log_message(fmt, *args)

    def send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        if not self.path.startswith(("/api/", "/audio/", "/images/")):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        if self.path == "/api/levels":
            out = []
            for lv, cfg in levels().items():
                bank = load_bank(lv)
                cfg["bankSizes"] = {k: len(v) for k, v in bank.items()}
                out.append(cfg)
            return self.send_json(out)
        m = re.match(r"^/api/bank/([a-z0-9]+)$", self.path)
        if m:
            return self.send_json(load_bank(m.group(1)))
        if self.path == "/api/attempts":
            atts = [with_grade(json.loads(f.read_text())) for f in ATTEMPTS.glob("*.json")]
            atts.sort(key=lambda a: a.get("finishedAt", ""), reverse=True)
            return self.send_json(atts)
        m = re.match(r"^/api/attempts/([^/]+)$", self.path)
        if m:
            f = ATTEMPTS / f"{m.group(1)}.json"
            if not SAFE_ID.match(m.group(1)) or not f.exists():
                return self.send_json({"error": "not found"}, 404)
            return self.send_json(with_grade(json.loads(f.read_text())))
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/attempts":
            return self.send_json({"error": "not found"}, 404)
        att = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if not SAFE_ID.match(att.get("id", "")):
            return self.send_json({"error": "bad id"}, 400)
        (ATTEMPTS / f"{att['id']}.json").write_text(json.dumps(att, ensure_ascii=False, indent=1))
        req = grading_request(att)
        if req:
            (PENDING / f"{att['id']}.json").write_text(json.dumps(req, ensure_ascii=False, indent=1))
        return self.send_json({"ok": True})


def main():
    for d in (ATTEMPTS, PENDING, GRADED):
        d.mkdir(parents=True, exist_ok=True)
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8004
    print(f"HSK practice exams: http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
