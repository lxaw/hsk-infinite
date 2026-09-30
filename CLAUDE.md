# HSK practice exams (HSK 4, 5, 6)

Local, randomly generated HSK mock exams: HSK 4/5/6 in the HSK 2.0 format, plus 新HSK 4 (`hsk4n`)
in the new HSK 3.0 format. See README.md for running it and
for how the banks are built. Each level's layout, timing, scoring and grading rubrics live in
`levels/<level>.json`; questions live in `bank/<level>/<PART>.json` (schema: `bank/SCHEMA.md`).

## Grading free writing ("grade my HSK writing" or similar)

Free-writing parts are graded by you, not by the site:
HSK 4 看图用词造句 (5 × 0–8), HSK 5 两篇短文 (2 × 0–30), HSK 6 缩写 (0–100), and on the new-format
新HSK 4 (level `hsk4n`, HSK 3.0) 看图用词造句 (5 × 0–10) plus one topic essay 写短文 (0–50, ≥80 字).

1. Find ungraded requests: every `submissions/pending/<id>.json` without a matching
   `submissions/graded/<id>.json` (`ls submissions/pending submissions/graded`).
2. Each request is self-contained. For every item:
   - `kind` tells you the task; `rubric` and `max` are the scale to use; `response` is the
     learner's text and `responseChars` its length in characters (`targetChars` = the target).
   - `picture_sentence` / `essay_picture`: **look at the picture first** with Read (`image`).
     `scene` is only the prompt the picture was drawn from; the picture is what counts.
   - `essay_words`: check all five `words` are used, correctly.
   - `essay_topic` (新HSK 4): the essay must answer the `task` prompt and reach `targetChars`.
   - `summary` (缩写): compare against the full source `story` (and its `title`); check key events,
     order, a title, no added opinions, ~400 characters.
   - `models`/`model` are sample answers, not the only correct ones.
   - Be a fair but real HSK examiner. No credit for English or pinyin.
3. Write `submissions/graded/<id>.json`:

```json
{
  "attemptId": "<id>",
  "gradedAt": "<ISO timestamp>",
  "items": [
    {"qnum": 96, "score": 6, "max": 8,
     "feedback": "One to three sentences in English: what is good, what is wrong and why.",
     "corrected": "A corrected / improved version of the learner's text (Chinese). For 缩写, the 2-3 most important corrections."}
  ]
}
```

   One entry per pending item with the same `qnum`s; `score` is an integer from 0 to `max`.
4. Tell the user each score with a one-line reason, the writing total (the site adds the
   auto-scored parts), and one or two concrete things to practise. The results page picks the
   grade up within ~10 s.

Never edit `submissions/attempts/` — those are the user's answers.

## Working on the banks

- Add items with `tools/add_batch.py LEVEL PART batch.json`; small edits with `tools/fix.py`.
- Validate: `.venv/bin/python tools/validate.py --level LEVEL` must report `errors: 0`.
  HSK 4 and 新HSK 4: no HARD out-of-syllabus words (新HSK 4 is checked against the HSK 3.0 (2025)
  lists in `data/wordlists_v3`; the level config's `syllabus: "v3"` selects them).
  HSK 5/6: HARD words are warnings (real papers exceed the list) but keep them rare and whitelist proper nouns in `data/whitelist_<level>.txt`; the
  validator also flags items with too few advanced words.
- Items with more than one defensible answer are the main risk. For word banks, cloze, tuple cloze,
  sentence insertion and 病句, try every option in every blank; for ordering, try all orders.
- Regenerate media after edits: `tools/build_audio.py --level L` (cached) and
  `tools/build_images.py --level L` for new picture items — look at every new picture and
  rewrite the `scene` if it shows any writing or doesn't clearly show the task.
- Test: with `server.py` running, `.venv/bin/python tools/e2e_test.py --level L`.
- Write original items. The textbooks in `../textbooks` are for vocabulary, grammar and topics
  only; 缩写 stories must be original, not retellings of well-known anecdotes.
