"""Local server for the HSK practice exams (HSK 4, 5, 6).

    .venv/bin/python server.py [PORT] [--auto-exit]    # then open http://localhost:8004

Stop it with Ctrl+C or by closing the terminal. With --auto-exit (what HSK Exams.app uses) it also stops by
itself about half a minute after the last browser tab showing it is closed: open pages ping /api/ping
(site/alive.js) and say /api/bye when they close.

Serves site/ and a small JSON API:
  GET  /api/levels                 level configs (levels/*.json) + bank sizes
  GET  /api/bank/<level>           all bank units for a level (read live from bank/<level>/*.json)
  GET  /api/attempts               past attempts (all levels), newest first, with Claude grades merged in
  GET  /api/attempts/<id>          one attempt
  GET  /api/ping?c=<id>            a page is open (heartbeat);  POST /api/bye?c=<id>: it closed
  POST /api/attempts               save a finished attempt; if it has free-writing answers, also writes
                                   submissions/pending/<id>.json for Claude Code to grade
Grades written by Claude to submissions/graded/<id>.json are picked up automatically.
"""
import json
import re
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SITE, BANK, LEVELS = ROOT / "site", ROOT / "bank", ROOT / "levels"
SUB = ROOT / "submissions"
ATTEMPTS, PENDING, GRADED = SUB / "attempts", SUB / "pending", SUB / "graded"
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# Open pages, by client id -> last heartbeat. time.monotonic() doesn't advance while the Mac sleeps,
# so waking up from sleep doesn't look like every page went quiet.
CLIENTS, CLIENTS_LOCK = {}, threading.Lock()
STALE = 150   # s without a heartbeat before a page counts as gone (background tabs ping as rarely as once a minute)
GRACE = 30    # s with no open page before an --auto-exit server stops (also covers reloads and the first page load)


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

    def client_id(self):
        m = re.search(r"[?&]c=([A-Za-z0-9]{1,32})", self.path)
        return m.group(1) if m else None

    def do_GET(self):
        if self.path.startswith("/api/ping"):
            if self.client_id():
                with CLIENTS_LOCK:
                    CLIENTS[self.client_id()] = time.monotonic()
            return self.send_json({"ok": True})
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
        if self.path.startswith("/api/bye"):
            with CLIENTS_LOCK:
                CLIENTS.pop(self.client_id(), None)
            return self.send_json({"ok": True})
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


def stop_when_unused(server):
    """--auto-exit: shut the server down once no page has been open for GRACE seconds."""
    empty_since = time.monotonic()
    while True:
        time.sleep(5)
        now = time.monotonic()
        with CLIENTS_LOCK:
            for c, seen in list(CLIENTS.items()):
                if now - seen > STALE:
                    del CLIENTS[c]
            open_pages = len(CLIENTS)
        if open_pages:
            empty_since = None
        elif empty_since is None:
            empty_since = now
        elif now - empty_since > GRACE:
            print("No HSK page open any more; stopping the server.", flush=True)
            server.shutdown()
            return


def main():
    for d in (ATTEMPTS, PENDING, GRADED):
        d.mkdir(parents=True, exist_ok=True)
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    port = int(args[0]) if args else 8004
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"HSK practice exams: http://localhost:{port}  (Ctrl+C to stop"
          + (", or just close the browser tab)" if "--auto-exit" in sys.argv else ")"), flush=True)
    if "--auto-exit" in sys.argv:
        threading.Thread(target=stop_when_unused, args=(server,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
