"""End-to-end test in headless Chrome (needs server.py on :8004 and `pip install playwright`).

    .venv/bin/python tools/e2e_test.py --level hsk4 [--keep]

1. Exam-mode listening: the audio sequence starts and reaches the first question.
2. Oracle run: a full practice paper answered through the UI with its own answer key; every
   shuffled key is mapped back to the bank's answer. Expect listening/reading 100 and the
   auto-scored writing parts at full marks (free writing pending).
3. Anti-oracle run: every answer wrong -> 0 everywhere.
4. Grading round-trip: writes a fake Claude grade (half marks) for run 2 and checks the results
   page picks it up (writing total, grand total, history row).
Attempts it creates are deleted afterwards unless --keep. Screenshots go to scratch/e2e/.
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "scratch/e2e"
SHOTS.mkdir(parents=True, exist_ok=True)
URL = "http://localhost:8004/"
LET = "ABCDEFGH"
args = sys.argv[1:]
LEVEL = args[args.index("--level") + 1] if "--level" in args else "hsk4"
CFG = json.loads((ROOT / "levels" / f"{LEVEL}.json").read_text())
PARTS = {p["id"]: {**p, "section": s["key"]} for s in CFG["sections"] for p in s["parts"]}
BANK = {f.stem: {u["id"]: u for u in json.loads(f.read_text())} for f in (ROOT / "bank" / LEVEL).glob("*.json")}
TITLE = {s["key"]: s["name"].split(" ")[0] for s in CFG["sections"]}
failures, created = [], []


def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        failures.append(msg)


def fresh(pg):
    pg.goto(URL + f"#/{LEVEL}")
    pg.evaluate("localStorage.clear()")
    pg.reload()
    pg.wait_for_selector(".card")


def verify_key(exam):
    bad = 0
    blocks = {b["unitId"]: b for b in exam["blocks"]}
    for q in exam["questions"]:
        t, u, b, c = PARTS[q["part"]]["type"], BANK[q["part"]][q["unitId"]], blocks[q["unitId"]], q.get("correct")
        if t == "tf":
            ok = c == u["answer"]
        elif "optOrder" in q:
            src = u["questions"][q["sub"]] if "sub" in q else u
            ok = src["options"][q["optOrder"][c]] == src["options"][src["answer"]]
        elif t == "wordbank":
            ok = b["bankOrder"][LET.index(c)] == u["items"][q["sub"]]["answer"]
        elif t == "insert":
            ok = b["sentOrder"][LET.index(c)] == u["answers"][q["sub"]]
        elif t == "order":
            ok = "".join(b["order"][LET.index(L)] for L in c) == u["answer"]
        elif t == "arrange":
            ok = c == u["answer"]
        else:
            ok = True
        bad += not ok
    return bad


def answer_section(pg, right):
    exam = pg.evaluate("JSON.parse(localStorage.getItem('hsk-exam'))")
    if exam["secIndex"] == 0:
        check(verify_key(exam) == 0, f"all {len(exam['questions'])} shuffled answer keys map back to the bank answers")
    sec = exam["sections"][exam["secIndex"]]
    s = next(x for x in CFG["sections"] if x["key"] == sec)
    if exam.get("phase") == "read":
        pg.click("#doneReading")
    for q in exam["questions"]:
        n, t, c = q["qnum"], PARTS[q["part"]]["type"], q.get("correct")
        if not s["first"] <= n < s["first"] + s["count"]:
            continue
        if q.get("fill"):  # short written answer (HSK 3.0 levels 7-9)
            pg.fill(f'input[data-text="{n}"]', c if right else "错")
        elif t == "tf":
            pg.click(f'.choice[data-q="{n}"][data-v="{str(c if right else not c).lower()}"]')
        elif "optOrder" in q:
            pg.click(f'.choice[data-q="{n}"][data-v="{c if right else (c + 1) % len(q["optOrder"])}"]')
        elif t in ("wordbank", "insert"):
            opts = [o for o in pg.eval_on_selector(f'select[data-q="{n}"]', "s => [...s.options].map(o => o.value)") if o]
            pg.select_option(f'select[data-q="{n}"]', c if right else next(o for o in opts if o != c))
        elif t == "order":
            for L in (c if right else c[::-1]):
                pg.click(f'button[data-order="{n}"][data-v="{L}"]')
        elif t == "arrange":
            pg.fill(f'input[data-text="{n}"]', c if right else c[::-1])
        elif t == "free":
            pg.fill(f'textarea[data-text="{n}"]', "他正在认真地学习。")
    return sec


def take_paper(pg, right, tag):
    fresh(pg)
    pg.check("#practice")
    pg.click('[data-mode="full"]')
    for _ in CFG["sections"]:
        pg.wait_for_selector(".part")
        sec = answer_section(pg, right)
        pg.screenshot(path=SHOTS / f"{LEVEL}_{tag}_{sec}.png")
        pg.click("#finishSection")
        pg.click("#finishSection")
        if sec != CFG["sections"][-1]["key"]:
            pg.wait_for_function(f"!document.querySelector('h1').textContent.includes('{TITLE[sec]}')")
    pg.wait_for_selector(".scores", timeout=10000)
    created.append(pg.url.split("/")[-1])
    return created[-1], scores(pg)


def scores(pg):
    return pg.eval_on_selector_all(".score .v", "els => els.map(e => e.innerText.replace(/\\s+/g, ' '))")


def main():
    errors = []
    # Per section: auto-scored points and (for sections with free writing) the points a half-marks grade adds.
    SECS = [s["key"] for s in CFG["sections"]]
    FREE = {k: [p for p in PARTS.values() if p["section"] == k and p["type"] == "free"] for k in SECS}
    AUTO = {k: sum(p.get("points", 0) * p.get("units", 0) for p in PARTS.values() if p["section"] == k and p["type"] != "free") for k in SECS}
    GRADE = {k: sum((p["points"] // 2) * p["units"] for p in FREE[k]) for k in SECS}
    full = sum(AUTO[k] + GRADE[k] if FREE[k] else 100 for k in SECS)
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True, args=["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
        pg = b.new_context(viewport={"width": 1100, "height": 900}, permissions=["microphone"]).new_page()
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and "404" not in m.text and errors.append(m.text))

        print(f"[{LEVEL}] 1. exam-mode listening audio")
        fresh(pg)
        pg.click('[data-mode="listening"]')
        pg.click("#startAudio")
        first = CFG["sections"][0]["first"]
        pg.wait_for_function(f"document.querySelector('#nowPlaying').textContent.includes('第 {first} 题')", timeout=90000)
        check(True, f"audio sequence reached question {first}")
        pg.goto(URL + f"#/{LEVEL}")
        pg.wait_for_timeout(1500)

        print(f"[{LEVEL}] 2. oracle run (all correct)")
        att, v = take_paper(pg, True, "right")
        print("    ", v)
        for i, k in enumerate(SECS):
            if FREE[k]:
                check(v[i].startswith(f"{AUTO[k]} +"), f"{k} auto parts = {AUTO[k]}, free writing pending")
            else:
                check(v[i].startswith("100"), f"{k} = 100")
        pending = ROOT / "submissions/pending" / f"{att}.json"
        check(pending.exists(), "pending grading request written")

        print(f"[{LEVEL}] 3. anti-oracle run (all wrong)")
        _, v2 = take_paper(pg, False, "wrong")
        print("    ", v2)
        for i, k in enumerate(SECS):
            check(v2[i].startswith("0 +" if FREE[k] else "0"), f"{k} = 0 when every answer is wrong")

        print(f"[{LEVEL}] 4. grading round-trip")
        req = json.loads(pending.read_text())
        check(all(it.get("rubric") and it.get("max") for it in req["items"]), "request items carry rubric and max")
        grade = {"attemptId": att, "gradedAt": "test",
                 "items": [{"qnum": it["qnum"], "score": it["max"] // 2, "max": it["max"], "feedback": "test", "corrected": "测试。"} for it in req["items"]]}
        (ROOT / "submissions/graded" / f"{att}.json").write_text(json.dumps(grade, ensure_ascii=False))
        pg.goto(URL + f"#/result/{att}")
        pg.reload()
        pg.wait_for_selector(".scores")
        v3 = scores(pg)
        print("    ", v3)
        for i, k in enumerate(SECS):
            if FREE[k]:
                check(v3[i].startswith(str(AUTO[k] + GRADE[k])), f"{k} = {AUTO[k]} + {GRADE[k]}")
        if CFG.get("noPass"):
            check(len(v3) == len(SECS), "no total is shown for a level without a pass mark")
        else:
            check(v3[len(SECS)].startswith(str(full)), f"total = {full}")
        check(pg.locator(".fb").count() >= len(req["items"]), "feedback shown for each graded item")
        pg.screenshot(path=SHOTS / f"{LEVEL}_graded_result.png")
        pg.goto(URL + f"#/{LEVEL}")
        pg.wait_for_selector(".hist")
        if not CFG.get("noPass"):
            check(str(full) in pg.inner_text(".hist"), "history table shows the graded total")

        print(f"[{LEVEL}] 5. drill, progress, missed words, answer sheet, exam day")
        fresh(pg)
        pg.click(f'[data-drill="{CFG["sections"][1]["parts"][0]["id"]}"]')
        pg.wait_for_selector("[data-check]")
        n_checks = pg.locator("[data-check]").count()
        pg.click("[data-check] >> nth=0")
        pg.wait_for_selector(".drillfb .rv")
        check(pg.locator("fieldset.blk[disabled]").count() == 1 and pg.locator("[data-check]").count() == n_checks - 1, "drill: Check locks the block and shows the review")
        pg.screenshot(path=SHOTS / f"{LEVEL}_drill.png", full_page=False)
        pg.click("#finishBottom")
        pg.click("#finishBottom")
        pg.wait_for_selector(".scores", timeout=10000)
        created.append(pg.url.split("/")[-1])
        check("drill" in pg.inner_text("main"), "drill result is labelled as a drill")

        pg.goto(URL + f"#/progress/{LEVEL}")
        pg.wait_for_selector("svg.chart")
        groups = len({p["group"] for p in PARTS.values()})
        check(pg.locator("table.parts tr").count() == groups + 1, f"progress: one row per part ({groups})")
        box = pg.locator("#hit").bounding_box()
        pg.mouse.move(box["x"] + box["width"] - 5, box["y"] + box["height"] / 2)
        check(pg.locator("#tip").is_visible(), "progress: hovering the chart shows a tooltip")
        pg.screenshot(path=SHOTS / f"{LEVEL}_progress.png", full_page=True)

        pg.goto(URL + f"#/words/{LEVEL}")
        pg.wait_for_selector("table.words")
        rows = pg.locator("table.words tr").count() - 1
        check(rows > 0, f"missed words: {rows} words from the all-wrong paper")
        with pg.expect_download() as dl:
            pg.click("#wexport")
        text = Path(dl.value.path()).read_text(encoding="utf-8")
        check(text.startswith("#separator:tab") and len(text.strip().splitlines()) == rows + 4, "Anki export has the header and one line per word")
        pg.screenshot(path=SHOTS / f"{LEVEL}_words.png")

        pg.goto(URL + f"#/sheet/{att}")
        pg.wait_for_selector(".sheet")
        check(pg.locator(".bub.on").count() > 0 and pg.locator(".grid .gr").count() > 0, "answer sheet shows filled bubbles and writing grids")
        pg.screenshot(path=SHOTS / f"{LEVEL}_sheet.png", full_page=True)

        pg.goto(URL + f"#/examday/{LEVEL}")
        pg.wait_for_selector("#beginExam")
        check(pg.locator("#beginExam").is_disabled(), "exam day: Begin is locked until the checklist is done")
        pg.click("#soundTest")
        for k in ("quiet", "time", "rules"):
            pg.check(f'[data-ck="{k}"]')
        check(pg.locator("#beginExam").is_enabled(), "exam day: checklist complete unlocks Begin")
        pg.screenshot(path=SHOTS / f"{LEVEL}_examday.png")
        pg.click("#beginExam")
        pg.wait_for_selector("#startAudio")
        check(pg.locator("#finishSection").is_disabled(), "exam day: listening can't be finished before the recording ends")
        pg.evaluate("localStorage.clear()")

        if CFG.get("speaking"):
            print(f"[{LEVEL}] 6. speaking practice")
            # The OS may block a real microphone for a script-launched Chrome; use a synthetic tone instead.
            pg.add_init_script("""navigator.mediaDevices.getUserMedia = async () => {
                const ctx = new AudioContext(), osc = ctx.createOscillator(), dest = ctx.createMediaStreamDestination();
                osc.connect(dest); osc.start(); return dest.stream; };""")
            pg.goto(URL + f"#/speaking/{LEVEL}")
            pg.reload()
            pg.click("#spStart")
            n = sum(p["units"] * p.get("questions", 1) for p in CFG["speaking"]["parts"])
            for k in range(n):
                pg.wait_for_selector("#spNow, #spDone", timeout=240000)  # a listen-and-answer recording can run two minutes
                if pg.locator("#spNow").count():
                    pg.click("#spNow")
                pg.click("#spDone")
                pg.wait_for_selector("#spNext")
                if k == 0:
                    check(pg.locator("#spCtl audio").count() == 1, "speaking: the answer was recorded and can be played back")
                pg.click("#spNext")
            pg.wait_for_selector("h1:has-text('Speaking done')")
            check(pg.locator("main audio").count() == n, f"speaking: summary lists all {n} recordings")
            pg.screenshot(path=SHOTS / f"{LEVEL}_speaking.png", full_page=True)
        b.close()

    if "--keep" not in args:
        for i in created:
            for d in ("attempts", "pending", "graded"):
                (ROOT / "submissions" / d / f"{i}.json").unlink(missing_ok=True)
    check(not errors, f"no JS errors {errors[:3]}")
    print("FAILED:" if failures else "ALL PASSED", failures or "")
    sys.exit(1 if failures else 0)


def cleanup():
    """Remove the attempts this run created (also after a crash), so test data never mixes with the user's."""
    if "--keep" not in args:
        for i in created:
            for d in ("attempts", "pending", "graded"):
                (ROOT / "submissions" / d / f"{i}.json").unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        main()
    finally:
        cleanup()
