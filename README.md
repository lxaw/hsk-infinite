# HSK practice exams — HSK 4, 5, 6

Randomly generated HSK mock exams (HSK 2.0 format: 300 points, 180 to pass), graded in the browser.
Free writing (HSK 4 看图造句, HSK 5 短文, HSK 6 缩写) is graded by Claude Code.

## Run it

**Mac:** double-click **HSK Exams.app** (keep it in this folder; dragging it to the Dock just adds a shortcut). It starts
the local server if it isn't running and opens http://localhost:8004 in your browser. The server
keeps running in the background; to stop it, run `pkill -f server.py`.

Or from a terminal (any Python 3.9+, no packages needed):

```sh
python3 server.py
# open http://localhost:8004  — pick HSK 4 / 5 / 6 at the top
```

If macOS says the app "can't be opened" (only happens when it was downloaded as a zip rather
than cloned), right-click it → **Open** once.

- **Full exam** or one section. Exam mode is timed and plays the listening once, continuously,
  like the real test (then 3 minutes to check answers). **Practice mode** has no timer and lets
  you replay any clip; for HSK 6 缩写 the story stays visible.
- HSK 6 缩写 in exam mode: 10 minutes reading, then the story disappears and 35 minutes of writing
  start, with a character counter.
- Each paper draws questions at random, preferring the ones you've seen least; answer options are
  reshuffled every time.
- Results: section scores, every answer, listening transcripts with audio, 病句 explanations.
- **Grading writing**: after finishing, open Claude Code in `~/Desktop/hsk` and say
  *"grade my HSK writing"*. The results page updates by itself.
- Voice samples: http://localhost:8004/voices.html

## Exam formats used

| | Listening | Reading | Writing |
|---|---|---|---|
| **HSK 4** (100 Qs) | 1–10 true/false · 11–25 two-line dialogues · 26–35 long dialogues · 36–45 passages (2 Qs) | 46–55 word bank · 56–65 order A/B/C · 66–79 short passages · 80–85 passages (2 Qs) — 40 min | 86–95 arrange words · 96–100 picture + word → sentence — 25 min |
| **HSK 5** (100 Qs) | 1–20 two-line dialogues · 21–30 long dialogues · 31–45 passages (2–3 Qs) | 46–60 cloze (each blank its own options, some sentence-level) · 61–70 pick the matching statement · 71–90 passages (4 Qs) — 45 min | 91–98 arrange words · 99 essay with 5 given words · 100 picture essay (~80 字 each) — 40 min |
| **HSK 6** (101 Qs) | 1–15 pick the matching statement · 16–30 3 interviews (5 Qs) · 31–50 passages (3–4 Qs) | 51–60 病句 · 61–70 word-set cloze · 71–80 sentence insertion (A–E) · 81–100 passages (4 Qs) — 50 min | 101 缩写: read ~1000 字 (10 min), write ~400 字 (35 min) |

Scoring: each section is out of 100. Listening and reading scale with the number correct.
Writing is an **estimate** (the official weights aren't published):
HSK 4 = 10 × 6 + 5 × 0–8; HSK 5 = 8 × 5 + 2 × 0–30; HSK 6 = 缩写 0–100.
Rubrics are in `levels/<level>.json` and travel with each grading request.

Assumptions not taken from an official recording or paper: the formats above are from the
published HSK 2.0 structure (from knowledge, not a downloaded sample paper); each question is
announced as "第N题" and groups as "第X到Y题是根据下面一段话/采访"; answer pauses are 8–14 s
depending on the part; after listening there are 3 minutes to check answers.

## Question bank

Each level's bank holds enough units for about 10 complete papers without repeating an item
(new papers draw the least-used units first; after that, items start to recur). Ambiguity-prone
items (HSK 5 cloze and statement-matching, HSK 6 病句, word-set cloze and sentence insertion)
were checked by an independent blind solve against shuffled options; every mismatch or
second defensible answer was rewritten. HSK 6 has 10 original 缩写 stories.

## Rebuilding the banks and media

The build and test tools need `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`
plus `ffmpeg` (audio). Pictures use Z-Image-Turbo through mflux on Apple Silicon; the ~10 GB model
is not in the repo — `build_images.py` explains how to fetch and quantize it.

## Layout

```
levels/          per-level config: sections, parts, question types, timing, scoring, rubrics
bank/<level>/    question bank, one JSON per part (schema: bank/SCHEMA.md)
data/            official HSK 2012 word lists (wordlists/L1–L6), whitelists, syllabus notes
tools/
  validate.py      structure, answer balance, near-duplicates, out-of-syllabus words, difficulty
  build_audio.py   edge-tts listening audio (cached; voices in audio_config.json)
  build_images.py  Z-Image-Turbo pictures (local, Apple Silicon; model in models/)
  add_batch.py / fix.py   add items / apply text fixes
  e2e_test.py      headless-Chrome test of a full exam per level
site/            the web app; audio/<level>/, images/<level>/
submissions/     attempts/ (your answers), pending/ (writing to grade), graded/ (Claude's grades)
server.py        local server + JSON API
```

## Sources

- Vocabulary: official HSK 2.0 (2012) word lists, levels 1–6. HSK 4 was cross-checked word by
  word against the vocabulary appendices of 《HSK标准教程4》上/下 (596 of 602 match).
- Grammar points and topics: the tables of contents of 《HSK标准教程》4上/4下/5上/6上.
  **Only the 上 volumes of HSK 5 and 6 were available**; the 下 halves are covered by the official
  word lists and general knowledge of the exam.
- All passages, dialogues and stories are original; none are copied from the textbooks.
