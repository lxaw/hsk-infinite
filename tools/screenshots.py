"""Take the README screenshots (docs/screenshots/) in headless Chrome. Needs server.py on :8004.

    .venv/bin/python tools/screenshots.py take     # exam views + one finished HSK 4 demo paper
    (grade the demo paper's writing: submissions/graded/<id>.json, see CLAUDE.md)
    .venv/bin/python tools/screenshots.py results  # results page + home page with history
    .venv/bin/python tools/screenshots.py clean    # delete the demo attempt

The demo attempt id is kept in scratch/demo_attempt.txt.
"""
import json
import random
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs/screenshots"
OUT.mkdir(parents=True, exist_ok=True)
URL = "http://localhost:8004/"
DEMO = ROOT / "scratch/demo_attempt.txt"
VIEW = {"width": 1200, "height": 820}


def fresh(pg, level):
    pg.goto(URL + f"#/{level}")
    pg.evaluate("localStorage.clear()")
    pg.reload()
    pg.wait_for_selector(".card")


def exam(pg):
    return pg.evaluate("JSON.parse(localStorage.getItem('hsk-exam'))")


def scroll_to(pg, sel):
    pg.eval_on_selector(sel, "e => window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 80)")
    pg.wait_for_timeout(300)


def shot(pg, name):
    pg.screenshot(path=OUT / f"{name}.png")
    print("  ", name)


def answer(pg, cfg, rng, accuracy, writing):
    """Answer the current section through the UI; wrong answers with probability 1-accuracy."""
    parts = {p["id"]: p for s in cfg["sections"] for p in s["parts"]}
    ex = exam(pg)
    sec = next(s for s in cfg["sections"] if s["key"] == ex["sections"][ex["secIndex"]])
    if ex.get("phase") == "read":
        pg.click("#doneReading")
    for q in ex["questions"]:
        n, t, c = q["qnum"], parts[q["part"]]["type"], q.get("correct")
        if not sec["first"] <= n < sec["first"] + sec["count"]:
            continue
        right = rng.random() < accuracy
        if t == "tf":
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
            pg.fill(f'textarea[data-text="{n}"]', writing(q))


def take():
    rng = random.Random(7)
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True, args=["--autoplay-policy=no-user-gesture-required"])
        pg = b.new_page(viewport=VIEW)

        # listening, exam mode: the audio runs continuously like the real test
        fresh(pg, "hsk4")
        pg.click('[data-mode="listening"]')
        pg.click("#startAudio")
        pg.wait_for_function("document.querySelector('#nowPlaying').textContent.includes('第 3 题')", timeout=120000)
        pg.click('.choice[data-q="1"][data-v="true"]')
        pg.click('.choice[data-q="2"][data-v="false"]')
        shot(pg, "2-listening")

        # HSK 5 reading: cloze passages
        fresh(pg, "hsk5")
        pg.check("#practice")
        pg.click('[data-mode="reading"]')
        pg.wait_for_selector(".part")
        q46 = next(q for q in exam(pg)["questions"] if q["qnum"] == 46)
        pg.click(f'.choice[data-q="46"][data-v="{q46["correct"]}"]')
        shot(pg, "3-reading-hsk5")

        # HSK 6 reading: 病句 and sentence insertion
        fresh(pg, "hsk6")
        pg.check("#practice")
        pg.click('[data-mode="reading"]')
        pg.wait_for_selector(".part")
        scroll_to(pg, ".part:nth-of-type(3)")
        shot(pg, "4-reading-hsk6")

        # HSK 6 缩写: 10 minutes reading, then the story disappears
        fresh(pg, "hsk6")
        pg.click('[data-mode="writing"]')
        pg.wait_for_selector(".story")
        shot(pg, "5-summary-hsk6")

        # HSK 4 full paper in practice mode, finished, writing sent for grading
        cfg = json.loads((ROOT / "levels/hsk4.json").read_text())
        bank = {u["id"]: u for u in json.loads((ROOT / "bank/hsk4/W2.json").read_text())}
        fresh(pg, "hsk4")
        pg.check("#practice")
        pg.click('[data-mode="full"]')
        for i, s in enumerate(cfg["sections"]):
            pg.wait_for_selector(".part")
            answer(pg, cfg, rng, 0.85, lambda q: bank[q["unitId"]]["models"][0])
            if s["key"] == "writing":
                pg.wait_for_timeout(4300)  # let the previous section's "click again" label reset
                scroll_to(pg, ".part:has(img)")
                shot(pg, "6-writing-hsk4")
            pg.click("#finishSection")
            pg.click("#finishSection")
            if i < len(cfg["sections"]) - 1:
                pg.wait_for_function(f"!document.querySelector('h1').textContent.includes('{s['name'].split(' ')[0]}')")
        pg.wait_for_selector(".scores", timeout=10000)
        att = pg.url.split("/")[-1]
        DEMO.write_text(att)
        print("demo attempt:", att, "-> grade submissions/pending/%s.json" % att)
        b.close()


def results():
    att = DEMO.read_text().strip()
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        pg = b.new_page(viewport=VIEW)
        pg.goto(URL + f"#/result/{att}")
        pg.reload()
        pg.wait_for_selector(".scores")
        shot(pg, "7-results")
        scroll_to(pg, ".fb")
        shot(pg, "8-feedback")
        pg.goto(URL + "#/hsk4")
        pg.reload()
        pg.wait_for_selector(".hist")
        shot(pg, "1-home")
        b.close()


def clean():
    att = DEMO.read_text().strip()
    for d in ("attempts", "pending", "graded"):
        (ROOT / "submissions" / d / f"{att}.json").unlink(missing_ok=True)
    DEMO.unlink()
    print("removed", att)


if __name__ == "__main__":
    {"take": take, "results": results, "clean": clean}[sys.argv[1]]()
