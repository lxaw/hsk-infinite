"""Parse the HSK 3.0 (2025) vocabulary from the official 《HSK考试大纲》 PDF into data/wordlists_v3/.

    pdftotext -raw -f 77 -l 352 新版HSK考试大纲1219.pdf vocab_raw.txt
    python3 tools/parse_syllabus_v3.py vocab_raw.txt

Writes L1..L6.txt and L7-9.txt (one word per line, the level where the word is first introduced)
and words.tsv (seq, level, word, pinyin, part of speech).
"""
import re
import sys
from collections import Counter
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "wordlists_v3"
rows = {}
for line in open(sys.argv[1], encoding="utf-8"):
    m = re.match(r"^(\d+) ([1-6]|7-9)((?:（[^）]*）)*) (\S+?) (\S.*)$", line.strip())
    if not m:
        continue
    n, lvl, word, rest = int(m.group(1)), m.group(2), re.sub(r"\d+$", "", m.group(4)), m.group(5).split()
    pinyin = " ".join(t for t in rest if not re.search(r"[一-鿿]", t))
    pos = " ".join(t for t in rest if re.search(r"[一-鿿]", t))
    rows.setdefault(n, (lvl, word, pinyin, pos))

missing = [i for i in range(1, max(rows) + 1) if i not in rows]
print(len(rows), "rows; missing:", missing[:20], Counter(v[0] for v in rows.values()))
OUT.mkdir(parents=True, exist_ok=True)
for lvl in ["1", "2", "3", "4", "5", "6", "7-9"]:
    words = list(dict.fromkeys(w for (l, w, _, _) in rows.values() if l == lvl))
    (OUT / f"L{lvl}.txt").write_text("\n".join(words) + "\n", encoding="utf-8")
(OUT / "words.tsv").write_text("".join(f"{n}\t{l}\t{w}\t{p}\t{s}\n" for n, (l, w, p, s) in sorted(rows.items())), encoding="utf-8")
