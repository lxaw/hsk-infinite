"""Validate a level's question bank.

Structure checks per part type, duplicate ids, answer balance, near-duplicates, and an
out-of-syllabus word report (jieba). HARD = contains a character never seen in the allowed
vocabulary (rewrite it); SOFT = new combination of known characters (review; whitelist
transparent ones in data/whitelist.txt or data/whitelist_<level>.txt).
For HSK 5/6 it also reports difficulty: length and the share of the level's own new words.

    .venv/bin/python tools/validate.py --level hsk5 [--oov] [PART ...]
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path

import jieba

ROOT = Path(__file__).resolve().parent.parent
HAN = re.compile(r"[一-鿿]")
NUM = re.compile(r"^[0-9０-９零一二三四五六七八九十百千万亿两半几第%.:：点号月日年岁块元分角个]+$")
NEAR_DUP = 0.45
MIN_ADV = {5: 0.06, 6: 0.10}
MARK = re.compile(r"\[(\d+)\]")

args = sys.argv[1:]
LEVEL = args[args.index("--level") + 1] if "--level" in args else "hsk4"
CFG = json.loads((ROOT / "levels" / f"{LEVEL}.json").read_text())
N = CFG.get("num") or int(LEVEL[-1])
PARTS = {p["id"]: {**p, "section": s["key"]} for s in CFG["sections"] for p in s["parts"]}
BANK = ROOT / "bank" / LEVEL


def words(path):
    return {l.strip() for l in path.read_text(encoding="utf-8-sig").splitlines() if l.strip() and not l.startswith("#")}


WL = ROOT / "data" / ("wordlists_v3" if CFG.get("syllabus") == "v3" else "wordlists")  # HSK 3.0 (2025) or 2.0 (2012) lists
OFFICIAL = {i: words(WL / f"L{i}.txt") for i in range(1, 7)}
ALLOWED = set().union(*(OFFICIAL[i] for i in range(1, N + 1)))
LEVEL_WORDS = OFFICIAL[N]
BELOW = set().union(*(OFFICIAL[i] for i in range(1, N)))  # everything easier than this level
BELOW_CHARS = {c for w in BELOW for c in w if len(w) == 1}
for f in [ROOT / "data" / "whitelist.txt", ROOT / "data" / f"whitelist_{LEVEL}.txt", ROOT / "data" / f"textbook_{LEVEL}.txt"]:
    if f.exists():
        ALLOWED |= {l.split("\t")[0] for l in words(f)}
ALLOWED_CHARS = {c for w in ALLOWED for c in w}
for w in ALLOWED | set().union(*OFFICIAL.values()):
    jieba.add_word(w)
jieba.setLogLevel(60)


def composable(tok):
    ok = [True] + [False] * len(tok)
    for i in range(1, len(tok) + 1):
        ok[i] = any(ok[j] and tok[j:i] in ALLOWED for j in range(max(0, i - 6), i))
    return ok[-1]


def below_composable(tok):
    ok = [True] + [False] * len(tok)
    for i in range(1, len(tok) + 1):
        ok[i] = any(ok[j] and (tok[j:i] in BELOW or (i - j == 1 and tok[j] in BELOW_CHARS)) for j in range(max(0, i - 6), i))
    return ok[-1]


def advanced(tok):
    return len(tok) > 1 and not NUM.match(tok) and (tok in LEVEL_WORDS or (tok not in BELOW and not below_composable(tok)))


def tokens(text):
    return [t for t in jieba.cut(text, HMM=False) if HAN.search(t)]


def oov(text):
    out = []
    for tok in tokens(text):
        if NUM.match(tok) or tok in ALLOWED:
            continue
        if (len(tok) == 1 and tok not in ALLOWED_CHARS) or (len(tok) > 1 and not composable(tok)):
            out.append(tok)
    return out


def texts(part, u):
    t = part["type"]
    for k in ("passage", "statement", "question", "title", "story", "word", "task", "A", "B", "C", "answer"):
        if isinstance(u.get(k), str):
            yield MARK.sub("", u[k])
    for d in u.get("dialogue", []):
        yield d["t"]
    for k in ("options", "sentences", "bank", "words", "models"):
        for x in u.get(k, []):
            yield x
    if u.get("model"):
        yield u["model"]
    for q in u.get("questions", []):
        if q.get("question"):
            yield q["question"]
        yield from q["options"]
    if t == "wordbank":
        if u.get("example"):
            yield u["example"]["text"]
        for it in u["items"]:
            yield it["text"]


def norm(s):
    return re.sub(r"[\s，。？！、,.?!]", "", s)


def check_mcq(q, where, errs, ans, n=4):
    opts = q.get("options", [])
    if len(opts) != n:
        errs.append(f"{where}: needs {n} options")
    if len(set(opts)) != len(opts):
        errs.append(f"{where}: duplicate options")
    if not isinstance(q.get("answer"), int) or not 0 <= q["answer"] < len(opts):
        errs.append(f"{where}: bad answer")
    else:
        ans.append(q["answer"])


def check_audio_body(part, u, errs):
    if part["section"] != "listening":
        return
    if "dialogue" in u:
        spk = [d["s"] for d in u["dialogue"]]
        if any(s not in ("m", "f", "m2", "f2") for s in spk) or any(a == b for a, b in zip(spk, spk[1:])):
            errs.append(f"{u['id']}: dialogue speakers must alternate (m/f/m2/f2)")
    elif u.get("speaker") not in ("m", "f", "m2", "f2"):
        errs.append(f"{u['id']}: listening passage needs speaker")


def pieces_ok(sentence, pieces):
    s, rem = norm(sentence), sorted((norm(p) for p in pieces), key=len, reverse=True)
    while s:
        for p in rem:
            if s.startswith(p):
                rem.remove(p); s = s[len(p):]
                break
        else:
            return False
    return not rem


def check(part, u, errs, ans):
    i, t = u["id"], part["type"]
    if t == "tf":
        check_audio_body(part, u, errs)
        if not isinstance(u.get("answer"), bool):
            errs.append(f"{i}: answer must be bool")
        else:
            ans.append(u["answer"])
    elif t == "mcq":
        check_audio_body(part, u, errs)
        if part["section"] == "listening" and "dialogue" not in u and "passage" not in u:
            errs.append(f"{i}: listening item needs dialogue or passage")
        if not part.get("noQuestion") and not u.get("question"):
            errs.append(f"{i}: needs question")
        if u.get("passage") and MARK.search(u["passage"]):
            if sorted(int(k) for k in MARK.findall(u["passage"])) != list(range(1, len(MARK.findall(u["passage"])) + 1)):
                errs.append(f"{i}: blanks must be [1]..[n]")
        if part.get("explain") and not u.get("explain"):
            errs.append(f"{i}: needs explain")
        check_mcq(u, i, errs, ans)
    elif t == "mcq_group":
        check_audio_body(part, u, errs)
        n = len(u["questions"])
        if n not in part["questionsPerUnit"]:
            errs.append(f"{i}: {n} questions, expected {part['questionsPerUnit']}")
        if part.get("cloze"):
            marks = [int(k) for k in MARK.findall(u["passage"])]
            if marks != list(range(1, n + 1)):
                errs.append(f"{i}: cloze passage needs [1]..[{n}] in order, got {marks}")
        for k, q in enumerate(u["questions"]):
            if not part.get("cloze") and not q.get("question"):
                errs.append(f"{i}.{k}: needs question")
            check_mcq(q, f"{i}.{k}", errs, ans)
    elif t == "wordbank":
        # HSK 2.0: an example uses the sixth word. HSK 3.0: no example, the sixth word is a distractor.
        ex = [u["example"]] if u.get("example") else []
        used = [e["answer"] for e in ex] + [it["answer"] for it in u["items"]]
        if len(u["bank"]) != 6 or len(set(u["bank"])) != 6 or len(u["items"]) != 5:
            errs.append(f"{i}: bank needs 6 distinct words and 5 items")
        if len(set(used)) != len(used) or len(used) != (6 if ex else 5) or not all(0 <= a < 6 for a in used):
            errs.append(f"{i}: each bank word may be used at most once (got {used})")
        for it in ex + u["items"]:
            if it["text"].count("（ ）") != 1:
                errs.append(f"{i}: exactly one （ ） blank per item: {it['text'][:20]}")
        ans.extend(it["answer"] for it in u["items"])
    elif t == "insert":
        marks = [int(k) for k in MARK.findall(u["passage"])]
        n = len(u["answers"])
        if marks != list(range(1, n + 1)):
            errs.append(f"{i}: passage needs [1]..[{n}] in order")
        if sorted(u["answers"]) != list(range(len(u["sentences"]))):
            errs.append(f"{i}: answers must be a permutation of the sentences")
        ans.extend(u["answers"])
    elif t == "order":
        if sorted(u.get("answer", "")) != ["A", "B", "C"]:
            errs.append(f"{i}: answer must be a permutation of ABC")
        else:
            ans.append(u["answer"])
    elif t == "arrange":
        if norm("".join(u["pieces"])) == norm(u["answer"]):
            errs.append(f"{i}: pieces already in answer order")
        for s in [u["answer"]] + u.get("accepted", []):
            if not pieces_ok(s, u["pieces"]):
                errs.append(f"{i}: '{s}' is not made of exactly the pieces")
        if not u["answer"].endswith(("。", "？", "！")):
            errs.append(f"{i}: answer needs final punctuation")
    elif t == "free":
        k = part["kind"]
        need = {"picture_sentence": ["word", "scene", "models"], "essay_words": ["words", "model"],
                "essay_picture": ["scene", "model"], "essay_topic": ["task", "model"], "summary": ["title", "story", "model"]}[k]
        for f in need:
            if not u.get(f):
                errs.append(f"{i}: {k} needs {f}")
        if k == "picture_sentence":
            for m in u.get("models", []):
                if u["word"] not in m:
                    errs.append(f"{i}: model answer missing target word")
        if k == "essay_words":
            if len(u.get("words", [])) != 5:
                errs.append(f"{i}: needs 5 words")
            for w in u.get("words", []):
                if w not in u.get("model", ""):
                    errs.append(f"{i}: model essay missing word {w}")
        if k == "essay_topic" and part.get("targetChars"):
            m = len(re.sub(r"\s", "", u.get("model", "")))
            if m < part["targetChars"]:
                errs.append(f"{i}: model essay is {m} characters (needs at least {part['targetChars']})")
        if k == "summary":
            n = len(re.sub(r"\s", "", u.get("story", "")))  # incl. punctuation
            m = len(re.sub(r"\s", "", u.get("model", "")))
            if not 900 <= n <= 1400:
                errs.append(f"{i}: story is {n} characters incl. punctuation (want ~1000)")
            if not 350 <= m <= 450:
                errs.append(f"{i}: model summary is {m} characters (want ~400)")


def main():
    pos = [a for a in args if not a.startswith("--") and a != LEVEL]
    show = "--oov" in args
    ids, total_errs, oov_all, grams = Counter(), 0, Counter(), {}
    for pid in pos or list(PARTS):
        f = BANK / f"{pid}.json"
        if not f.exists():
            continue
        part, units = PARTS[pid], json.loads(f.read_text())
        errs, ans, lens, dens = [], [], [], []
        for u in units:
            ids[u["id"]] += 1
            if not u["id"].startswith(pid + "-"):
                errs.append(f"{u['id']}: id prefix should be {pid}-")
            try:
                check(part, u, errs, ans)
            except (KeyError, TypeError) as e:
                errs.append(f"{u.get('id')}: missing/bad field {e}")
                continue
            txt = "".join(texts(part, u))
            toks = tokens(txt)
            lens.append(len(HAN.findall(txt)))
            if toks and N >= 5:
                # "advanced" = multi-character words above the previous level (this level's list or beyond it)
                d = sum(advanced(t) for t in toks) / len(toks)
                dens.append(d)
                if len(toks) >= 25 and d < MIN_ADV[N]:
                    errs.append(f"{u['id']}: few advanced words ({d:.0%}) — probably too easy for {LEVEL.upper()}")
            for piece in texts(part, u):
                for w in oov(piece):
                    oov_all[w] += 1
                    if show:
                        print(f"  OOV {u['id']}: {w}")
            h = "".join(HAN.findall(txt))
            grams[u["id"]] = {h[k:k + 2] for k in range(len(h) - 1)}
        dist = Counter(ans)
        extra = f"  avg_len={sum(lens) // max(1, len(lens))}" + (f"  advanced_words={sum(dens) / max(1, len(dens)):.0%}" if dens else "")
        print(f"{pid:4} units={len(units):4}  answers={dict(sorted(dist.items(), key=str))}{extra}")
        for e in errs:
            print("   ERROR", e)
        total_errs += len(errs)
    keys = [k for k, g in grams.items() if len(g) >= 8]
    for a_i, a in enumerate(keys):
        for b in keys[a_i + 1:]:
            j = len(grams[a] & grams[b]) / len(grams[a] | grams[b])
            if j > NEAR_DUP:
                print(f"   NEAR-DUPLICATE {a} ~ {b}  (similarity {j:.2f})")
    dup = [i for i, c in ids.items() if c > 1]
    if dup:
        print("DUPLICATE IDS:", dup)
        total_errs += len(dup)
    hard = [(w, c) for w, c in oov_all.most_common() if any(ch not in ALLOWED_CHARS for ch in w)]
    soft = [(w, c) for w, c in oov_all.most_common() if all(ch in ALLOWED_CHARS for ch in w)]
    print("HARD out-of-syllabus (new characters):", " ".join(f"{w}×{c}" for w, c in hard) or "none")
    if N <= 4 or show:
        print("SOFT out-of-syllabus (known characters):", " ".join(f"{w}×{c}" for w, c in soft) or "none")
    else:
        print(f"SOFT out-of-syllabus: {len(soft)} distinct (use --oov to list)")
    print("errors:", total_errs)
    sys.exit(1 if total_errs else 0)


if __name__ == "__main__":
    main()
