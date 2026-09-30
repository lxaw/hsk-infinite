"use strict";
// HSK practice exams (levels 4–6). Everything level-specific comes from levels/<level>.json.

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const LET = "ABCDEFGH";
const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩";

let LEVELS = [];      // level configs from the server
let CFG = null;       // current level config
let BANK = {};        // current level bank
let ATTEMPTS = [];
let exam = null;      // in-progress paper
let tick = null, player = null, pauseTimer = null, listenSeq = 0, pollTimer = null, armedUntil = 0;

// ---------- utils ----------
function rand(n) { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; }
function shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function perm(n) { return shuffle([...Array(n).keys()]); }
const norm = (s) => String(s || "").replace(/[\s，。？！、,.?!；;：:“”"'（）()]/g, "");
// HSK counts answer-sheet squares: every character including punctuation, not spaces/newlines.
const hanCount = (s) => String(s || "").replace(/\s/g, "").length;
function fmtTime(ms) { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
function store(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function recall(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } }
function save() { store("hsk-exam", exam); }
async function api(path, opts) { const r = await fetch(path, opts); if (!r.ok) throw new Error(`${path}: ${r.status}`); return r.json(); }
function stopAudio() { listenSeq++; clearTimeout(pauseTimer); if (player) { player.onended = null; player.pause(); player = null; } }

const allParts = (cfg = CFG) => cfg.sections.flatMap((s) => s.parts.map((p) => ({ ...p, section: s.key })));
const partCfg = (id, cfg = CFG) => allParts(cfg).find((p) => p.id === id);
const sectionCfg = (key, cfg = CFG) => cfg.sections.find((s) => s.key === key);
function sectionOf(n, cfg = CFG) { return cfg.sections.find((s) => n >= s.first && n < s.first + s.count).key; }
function unit(id) { const p = id.slice(0, id.lastIndexOf("-")); return (BANK[p] || []).find((u) => u.id === id); }
const audio = (f) => `audio/${CFG.level}/${f}.mp3`;
const image = (id) => `images/${CFG.level}/${id}.jpg`;
const nQuestions = (part, u) => part.type === "mcq_group" ? u.questions.length : part.type === "wordbank" ? u.items.length
  : part.type === "insert" ? u.answers.length : 1;

async function useLevel(level) {
  if (CFG && CFG.level === level && Object.keys(BANK).length) return;
  CFG = LEVELS.find((l) => l.level === level) || LEVELS[0];
  BANK = await api(`/api/bank/${CFG.level}`);
  store("hsk-level", CFG.level);
}

// ---------- paper generation ----------
function usageCounts(level) {
  const c = {};
  for (const a of ATTEMPTS) if ((a.level || "hsk4") === level) for (const id of new Set((a.questions || []).map((q) => q.unitId))) c[id] = (c[id] || 0) + 1;
  return c;
}
function byUsage(list, used) { return shuffle(list).sort((a, b) => (used[a.id] || 0) - (used[b.id] || 0)); }

function pickUnits(part, used) {
  const pool = BANK[part.id] || [];
  if (part.kinds) return part.kinds.map((k) => byUsage(pool.filter((u) => u.kind === k), used)[0]);
  if (!part.questions) return byUsage(pool, used).slice(0, part.units);
  // Fill an exact question total with variable-size groups (e.g. 15 questions from groups of 2–3).
  for (let attempt = 0; attempt < 200; attempt++) {
    let left = part.questions; const out = [];
    for (const u of attempt ? shuffle(pool) : byUsage(pool, used)) {
      const n = nQuestions(part, u);
      if (n <= left && (left - n === 0 || left - n >= Math.min(...part.questionsPerUnit))) { out.push(u); left -= n; }
      if (!left) return out;
    }
  }
  return [];
}

function buildPaper(mode, practice) {
  const used = usageCounts(CFG.level);
  const secs = mode === "full" ? CFG.sections.map((s) => s.key) : [mode];
  const blocks = [], questions = [];
  for (const key of secs) {
    const sec = sectionCfg(key);
    let qnum = sec.first;
    for (const part of sec.parts) {
      const units = pickUnits(part, used);
      const need = part.questions || null;
      if (!units.length || units.some((u) => !u) || (!need && units.length < part.units)) throw new Error(`Not enough ${part.id} items in the ${CFG.short} bank yet`);
      for (const u of units) {
        const b = { part: part.id, unitId: u.id, qnums: [] };
        const addQ = (extra) => { const q = { qnum: qnum++, part: part.id, unitId: u.id, response: null, ...extra }; questions.push(q); b.qnums.push(q.qnum); return q; };
        const mcq = (src, extra = {}) => { const n = src.options.length; const o = src.keepOrder ? [...Array(n).keys()] : perm(n); addQ({ ...extra, optOrder: o, correct: o.indexOf(src.answer) }); };
        switch (part.type) {
          case "tf": addQ({ correct: u.answer }); break;
          case "mcq": mcq(u); break;
          case "mcq_group": u.questions.forEach((q, k) => mcq(q, { sub: k })); break;
          case "wordbank":
            b.bankOrder = perm(u.bank.length); b.itemOrder = perm(u.items.length);
            b.itemOrder.forEach((k) => addQ({ sub: k, correct: LET[b.bankOrder.indexOf(u.items[k].answer)] }));
            break;
          case "insert":
            b.sentOrder = perm(u.sentences.length);
            u.answers.forEach((a, k) => addQ({ sub: k, correct: LET[b.sentOrder.indexOf(a)] }));
            break;
          case "order":
            b.order = shuffle(["A", "B", "C"]);
            addQ({ correct: [...u.answer].map((k) => LET[b.order.indexOf(k)]).join("") });
            break;
          case "arrange": {
            let p; do { p = shuffle(u.pieces); } while (norm(p.join("")) === norm(u.answer) && u.pieces.length > 1);
            b.pieces = p; addQ({ correct: u.answer, accepted: u.accepted || [] });
            break;
          }
          case "free": addQ({}); break;
        }
        blocks.push(b);
      }
    }
  }
  return {
    id: new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + Math.random().toString(36).slice(2, 6),
    level: CFG.level, mode, practice, createdAt: new Date().toISOString(), sections: secs, secIndex: 0, blocks, questions,
    deadline: null, listenState: null, phase: null,
  };
}

// ---------- rendering helpers ----------
const qById = (n) => exam.questions.find((q) => q.qnum === n);
function choiceBtns(q, opts) {
  return `<div class="choices">${q.optOrder.map((oi, di) => `<button class="choice ${q.response === di ? "on" : ""}" data-q="${q.qnum}" data-v="${di}"><span class="L">${LET[di]}</span>${esc(opts[oi])}</button>`).join("")}</div>`;
}
function playBtn(src, label = "▶ 播放") { return exam.practice ? `<button class="playbtn" data-play="${esc(src)}">${label}</button>` : ""; }
// Blanks in passages are written [1], [2] ... in the bank.
function blanks(text, fn) { return esc(text).replace(/\[(\d+)\]/g, (_, k) => fn(+k)); }
function counter(n, target) { return target ? `<div class="small muted counter" data-counter="${n}">${hanCount(qById(n).response)} 字 / 目标 ${target} 字</div>` : ""; }

function renderBlock(b) {
  const u = unit(b.unitId), part = partCfg(b.part), listening = part.section === "listening";
  const q0 = qById(b.qnums[0]);
  switch (part.type) {
    case "tf":
      return `<div class="q" id="q${q0.qnum}"><span class="qn">${q0.qnum}.</span>${playBtn(audio(u.id))}
        <div class="stmt">★ ${esc(u.statement)}</div>
        <div class="tf">${[["对 ✓", true], ["错 ✗", false]].map(([t, v]) => `<button class="choice ${q0.response === v ? "on" : ""}" data-q="${q0.qnum}" data-v="${v}">${t}</button>`).join("")}</div></div>`;
    case "mcq": {
      if (listening) return `<div class="q" id="q${q0.qnum}"><span class="qn">${q0.qnum}.</span>${playBtn(audio(u.id))}${choiceBtns(q0, u.options)}</div>`;
      const passage = u.passage ? `<div class="passage">${blanks(u.passage, (k) => `<b>${CIRCLED[k - 1]}</b>____`)}</div>` : "";
      const question = !part.noQuestion && u.question ? `<div class="stmt">★ ${esc(u.question)}</div>` : "";
      return `<div class="q" id="q${q0.qnum}"><span class="qn">${q0.qnum}.</span>${passage}${question}${choiceBtns(q0, u.options)}</div>`;
    }
    case "mcq_group": {
      if (listening) return b.qnums.map((n, k) => { const q = qById(n); return `<div class="q" id="q${n}"><span class="qn">${n}.</span>${k === 0 ? playBtn(audio(u.id), "▶ 录音") : ""} ${playBtn(audio(`${u.id}_q${q.sub}`), "▶ 问题")}${choiceBtns(q, u.questions[q.sub].options)}</div>`; }).join("");
      const head = `<span class="qn">${b.qnums[0]}–${b.qnums[b.qnums.length - 1]}.</span>`;
      const passage = part.cloze ? blanks(u.passage, (k) => `<b class="blank">（${b.qnums[k - 1]}）</b>`) : esc(u.passage);
      return `<div class="q"><div class="passage">${head}${u.title ? `<b>${esc(u.title)}</b>\n` : ""}${passage}</div></div>` +
        b.qnums.map((n) => { const q = qById(n), Q = u.questions[q.sub]; return `<div class="q" id="q${n}"><span class="qn">${n}.</span>${Q.question ? `<span class="stmt">★ ${esc(Q.question)}</span>` : ""}${choiceBtns(q, Q.options)}</div>`; }).join("");
    }
    case "wordbank": {
      const bankHtml = b.bankOrder.map((bi, di) => `<span class="${bi === u.example.answer ? "used" : ""}"><span class="L">${LET[di]}</span>${esc(u.bank[bi])}</span>`).join("");
      const exLetter = LET[b.bankOrder.indexOf(u.example.answer)];
      const sel = (q) => `<select data-q="${q.qnum}"><option value="">—</option>${b.bankOrder.map((bi, di) => bi === u.example.answer ? "" : `<option ${q.response === LET[di] ? "selected" : ""}>${LET[di]}</option>`).join("")}</select>`;
      return `<div class="bank">${bankHtml}</div>
        <div class="q"><span class="qn muted">例如：</span><span class="passage">${esc(u.example.text.replace("（ ）", `（ ${exLetter} ）`))}</span></div>
        ${b.qnums.map((n) => { const q = qById(n); return `<div class="q blankrow" id="q${n}"><span class="qn">${n}.</span>${sel(q)}<span class="passage">${esc(u.items[q.sub].text)}</span></div>`; }).join("")}`;
    }
    case "insert": {
      const sents = b.sentOrder.map((si, di) => `<div class="orderline"><span class="L">${LET[di]}</span>${esc(u.sentences[si])}</div>`).join("");
      const passage = blanks(u.passage, (k) => `<b class="blank">（${b.qnums[k - 1]}）</b>`);
      const sel = (q) => `<select data-q="${q.qnum}"><option value="">—</option>${b.sentOrder.map((_, di) => `<option ${q.response === LET[di] ? "selected" : ""}>${LET[di]}</option>`).join("")}</select>`;
      return `<div class="q"><div class="passage">${passage}</div><div class="bank" style="display:block">${sents}</div></div>
        <div class="q blankrow">${b.qnums.map((n) => `<span id="q${n}"><span class="qn">${n}.</span>${sel(qById(n))}</span>`).join(" ")}</div>`;
    }
    case "order": {
      const slots = [0, 1, 2].map((i) => `<span class="slot">${esc((q0.response || "")[i] || "")}</span>`).join("");
      return `<div class="q" id="q${q0.qnum}"><span class="qn">${q0.qnum}.</span>
        ${b.order.map((k, di) => `<div class="orderline"><span class="L">${LET[di]}</span>${esc(u[k])}</div>`).join("")}
        <div class="orderpick">${slots}${["A", "B", "C"].map((L) => `<button class="btn small" data-order="${q0.qnum}" data-v="${L}" ${(q0.response || "").includes(L) ? "disabled" : ""}>${L}</button>`).join("")}
        <button class="btn small" data-order="${q0.qnum}" data-v="">清除</button></div></div>`;
    }
    case "arrange":
      return `<div class="q" id="q${q0.qnum}"><span class="qn">${q0.qnum}.</span>
        <div class="pieces">${b.pieces.map((p) => `<button class="piece" data-piece="${q0.qnum}">${esc(p)}</button>`).join("")}</div>
        <input class="answer" data-text="${q0.qnum}" value="${esc(q0.response || "")}" placeholder="点击词语或直接输入 · tap the pieces or type"></div>`;
    case "free": return renderFree(part, u, q0);
  }
}

function renderFree(part, u, q) {
  const box = `<textarea class="answer ${part.kind === "picture_sentence" ? "" : "long"}" data-text="${q.qnum}" placeholder="${esc(part.prompt || "")}">${esc(q.response || "")}</textarea>${counter(q.qnum, part.targetChars)}`;
  if (part.kind === "picture_sentence")
    return `<div class="q w2" id="q${q.qnum}"><img src="${image(u.id)}" alt=""><div><span class="qn">${q.qnum}.</span><div class="word">${esc(u.word)}</div>${box}</div></div>`;
  if (part.kind === "essay_picture")
    return `<div class="q" id="q${q.qnum}"><span class="qn">${q.qnum}.</span><span class="muted">${esc(part.prompt)}</span><div class="w2"><img src="${image(u.id)}" alt=""><div>${box}</div></div></div>`;
  if (part.kind === "essay_words")
    return `<div class="q" id="q${q.qnum}"><span class="qn">${q.qnum}.</span><span class="muted">${esc(part.prompt)}</span>
      <div class="bank">${u.words.map((w) => `<span>${esc(w)}</span>`).join("")}</div>${box}</div>`;
  if (part.kind === "summary") {
    const phase = exam.practice ? "both" : exam.phase || "read";
    const story = `<div class="story"><h3>${esc(u.title || "")}</h3><div class="passage">${esc(u.story)}</div></div>`;
    if (phase === "read") return `<div class="q" id="q${q.qnum}"><div class="notice">阅读时间：请仔细阅读下面的文章。时间到后文章会消失，然后开始写作。<button class="btn small" id="doneReading">读完了 · Start writing now</button></div>${story}</div>`;
    return `<div class="q" id="q${q.qnum}"><span class="qn">${q.qnum}.</span><span class="muted">${esc(part.prompt)}</span>${phase === "both" ? story : ""}${box}</div>`;
  }
  return "";
}

function partGroups(sec) {
  const groups = [];
  for (const b of exam.blocks) {
    const part = partCfg(b.part);
    if (part.section !== sec) continue;
    let g = groups.find((x) => x.key === part.group);
    if (!g) groups.push((g = { key: part.group, head: allParts().find((p) => p.group === part.group), blocks: [] }));
    g.blocks.push(b);
  }
  return groups;
}

// ---------- exam view ----------
function renderExam() {
  const key = exam.sections[exam.secIndex], S = sectionCfg(key);
  $("#exambar").hidden = false;
  $("#sectionLabel").textContent = `${CFG.short} · ${S.name}`;
  if (S.readMinutes && !exam.practice && !exam.phase) { exam.phase = "read"; exam.deadline = null; save(); }
  let html = `<h1>${S.name}</h1><p class="muted">${CFG.name} · 第 ${S.first}${S.count > 1 ? `–${S.first + S.count - 1}` : ""} 题 · ${exam.practice ? "练习模式 practice (replay allowed, no timer)" : "考试模式 exam mode"}</p>`;
  if (key === "listening" && !exam.practice)
    html += `<div class="player" id="player"><button class="btn primary small" id="startAudio">${exam.listenState ? "继续 Resume" : "开始 Start listening"}</button>
      <span id="nowPlaying" class="small muted">音频只播放一次 · audio plays once, like the real exam</span><div class="bar"><i id="pbar"></i></div></div>`;
  for (const g of partGroups(key))
    html += `<section class="part"><div class="ph">${esc(g.head.title || "")}</div><div class="pd">${esc(g.head.desc || "")}</div>${g.blocks.map(renderBlock).join("")}</section>`;
  html += `<p><button class="btn primary" id="finishBottom">交卷 · Finish ${S.name}</button></p>`;
  $("#app").innerHTML = html;
  bindExam();
  startTimer();
}

function setResponse(n, v) { qById(n).response = v; save(); const c = $(`[data-counter="${n}"]`); if (c) c.textContent = c.textContent.replace(/^\d+/, hanCount(v)); }

function bindExam() {
  const app = $("#app");
  app.onclick = (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.q && t.classList.contains("choice")) {
      const raw = t.dataset.v;
      setResponse(+t.dataset.q, raw === "true" ? true : raw === "false" ? false : +raw);
      t.parentElement.querySelectorAll(".choice").forEach((c) => c.classList.toggle("on", c === t));
    } else if (t.dataset.order) {
      const n = +t.dataset.order, q = qById(n);
      setResponse(n, (t.dataset.v ? (q.response || "") + t.dataset.v : "").slice(0, 3) || null);
      rerenderQ(n);
    } else if (t.dataset.piece) {
      const n = +t.dataset.piece, inp = $(`[data-text="${n}"]`);
      inp.value = inp.value.replace(/[。？！]$/, "") + t.textContent;
      t.classList.add("used");
      setResponse(n, inp.value);
    } else if (t.dataset.play) playOnce(t.dataset.play);
    else if (t.id === "startAudio") startListening();
    else if (t.id === "finishBottom") finishSection();
    else if (t.id === "doneReading") startWritingPhase();
  };
  app.oninput = (e) => { if (e.target.dataset.text) setResponse(+e.target.dataset.text, e.target.value); };
  app.onchange = (e) => { if (e.target.tagName === "SELECT") setResponse(+e.target.dataset.q, e.target.value || null); };
  $("#finishSection").onclick = () => finishSection();
}

function rerenderQ(n) {
  const b = exam.blocks.find((x) => x.qnums.includes(n));
  const tmp = document.createElement("div");
  tmp.innerHTML = renderBlock(b);
  $(`#q${n}`).replaceWith(tmp.querySelector(`#q${n}`));
}

function startTimer() {
  clearInterval(tick);
  const S = sectionCfg(exam.sections[exam.secIndex]);
  if (exam.practice) { $("#timer").textContent = ""; return; }
  const mins = exam.phase === "read" ? S.readMinutes : S.minutes;
  if (!exam.deadline && mins) { exam.deadline = Date.now() + mins * 60000; save(); }
  const draw = () => {
    if (!exam.deadline) { $("#timer").textContent = ""; return; }
    const left = exam.deadline - Date.now();
    $("#timer").textContent = (exam.phase === "read" ? "阅读 " : "") + fmtTime(left);
    $("#timer").classList.toggle("low", left < 5 * 60000);
    if (left <= 0) { clearInterval(tick); exam.phase === "read" ? startWritingPhase() : finishSection(true); }
  };
  draw();
  tick = setInterval(draw, 1000);
}

function startWritingPhase() { exam.phase = "write"; exam.deadline = null; save(); renderExam(); }

// ---------- audio ----------
function playOnce(src) { stopAudio(); player = new Audio(src); player.play(); }

function listeningPlaylist() {
  const S = sectionCfg("listening");
  const seq = [{ src: audio("fixed/intro") }];
  let lastGroup = null;
  for (const b of exam.blocks) {
    const part = partCfg(b.part);
    if (part.section !== "listening") continue;
    if (part.group !== lastGroup) {
      lastGroup = part.group;
      if (allParts().some((p) => p.group === part.group && p.audioIntro)) seq.push({ src: audio(`fixed/intro_${part.group}`) });
    }
    if (part.type === "mcq_group") {
      const a = b.qnums[0], z = b.qnums[b.qnums.length - 1];
      seq.push({ src: audio(`fixed/range_${part.id}_${a}_${z}`), q: a }, { src: audio(b.unitId), q: a });
      b.qnums.forEach((n) => seq.push({ src: audio(`fixed/num${n}`), q: n }, { src: audio(`${b.unitId}_q${qById(n).sub}`), q: n }, { pause: part.pause * 1000, q: n }));
    } else {
      const n = b.qnums[0];
      seq.push({ src: audio(`fixed/num${n}`), q: n }, { src: audio(b.unitId), q: n }, { pause: part.pause * 1000, q: n });
    }
  }
  seq.push({ src: audio("fixed/end") });
  return { seq, review: S.reviewMinutes || 3 };
}

function startListening() {
  const { seq, review } = listeningPlaylist();
  exam.listenState = exam.listenState || { i: 0 };
  $("#startAudio").disabled = true;
  stopAudio();
  const token = listenSeq;
  const step = () => {
    if (token !== listenSeq || !exam || !exam.listenState) return;
    const i = exam.listenState.i;
    save();
    $("#pbar").style.width = `${(100 * i) / seq.length}%`;
    document.querySelectorAll(".q.now").forEach((el) => el.classList.remove("now"));
    if (i >= seq.length) {
      $("#nowPlaying").textContent = `听力结束 · ${review} 分钟检查答案 · minutes to check your answers`;
      exam.deadline = Date.now() + review * 60000; save(); startTimer();
      return;
    }
    const it = seq[i];
    if (it.q) {
      const el = $(`#q${it.q}`);
      if (el) { el.classList.add("now"); if (it.src && it.src.includes("/num")) el.scrollIntoView({ behavior: "smooth", block: "center" }); }
      $("#nowPlaying").textContent = `第 ${it.q} 题`;
    }
    const next = () => { exam.listenState.i = i + 1; step(); };
    if (it.pause) { pauseTimer = setTimeout(next, it.pause); return; }
    player = new Audio(it.src);
    player.onended = next;
    player.onerror = () => { console.warn("missing audio", it.src); next(); };
    player.play().catch(next);
  };
  step();
}

// ---------- section flow ----------
let armTimer = null;
function disarm() {
  armedUntil = 0;
  clearTimeout(armTimer);
  [$("#finishSection"), $("#finishBottom")].filter(Boolean).forEach((b) => { if (b.dataset.label) b.textContent = b.dataset.label; });
}
function finishSection(auto) {
  if (auto !== true && Date.now() > armedUntil) {
    // Inline confirmation (no browser dialogs): first click arms, second click within 4 s confirms.
    armedUntil = Date.now() + 4000;
    const sec = exam.sections[exam.secIndex];
    const left = exam.questions.filter((q) => sectionOf(q.qnum) === sec && (q.response === null || q.response === "")).length;
    const msg = left ? `还有 ${left} 题未答 · click again to finish` : "确定交卷？· click again to finish";
    const btns = [$("#finishSection"), $("#finishBottom")].filter(Boolean);
    btns.forEach((b) => { b.dataset.label ??= b.textContent; b.textContent = msg; });
    clearTimeout(armTimer);
    armTimer = setTimeout(disarm, 4000);
    return;
  }
  disarm();
  clearInterval(tick);
  stopAudio();
  Object.assign(exam, { deadline: null, listenState: null, phase: null });
  if (exam.secIndex < exam.sections.length - 1) { exam.secIndex++; save(); window.scrollTo(0, 0); renderExam(); }
  else submit();
}

// ---------- scoring ----------
function isCorrect(q) {
  const part = partCfg(q.part);
  if (part.type === "free") return null;
  if (part.type === "arrange") { const r = norm(q.response); return !!r && [q.correct, ...(q.accepted || [])].some((a) => norm(a) === r); }
  return q.response === q.correct;
}

function computeScores(att) {
  const out = {};
  for (const key of att.sections) {
    const qs = att.questions.filter((q) => sectionOf(q.qnum) === key);
    if (key === "writing") {
      let auto = 0, free = 0, pending = false;
      for (const q of qs) {
        const part = partCfg(q.part);
        if (part.type === "free") {
          const g = att.claudeGrade && att.claudeGrade.items.find((x) => x.qnum === q.qnum);
          if (g) free += Math.min(+g.score || 0, part.points); else pending = true;
        } else if (isCorrect(q)) auto += part.points;
      }
      out.writing = { auto, free: pending ? null : free, score: pending ? null : auto + free, provisional: auto };
    } else {
      const right = qs.filter(isCorrect).length;
      out[key] = { right, of: qs.length, score: Math.round((100 * right) / qs.length) };
    }
  }
  return out;
}

async function submit() {
  $("#exambar").hidden = true;
  const att = { ...exam, finishedAt: new Date().toISOString() };
  ["deadline", "listenState", "secIndex", "phase"].forEach((k) => delete att[k]);
  try {
    await api("/api/attempts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(att) });
    store("hsk-exam", null); exam = null;
    location.hash = `#/result/${att.id}`;
  } catch (e) {
    $("#app").innerHTML = `<div class="notice">Could not save the attempt (${esc(e.message)}). Is <code>server.py</code> running? Your answers are kept in this browser — reload to retry.</div>`;
  }
}

// ---------- home ----------
function papersAvailable() {
  let min = Infinity;
  for (const p of allParts()) {
    const pool = BANK[p.id] || [];
    if (p.kinds) p.kinds.forEach((k) => (min = Math.min(min, pool.filter((u) => u.kind === k).length)));
    else if (p.questions) min = Math.min(min, pool.reduce((s, u) => s + nQuestions(p, u), 0) / p.questions);
    else min = Math.min(min, pool.length / p.units);
  }
  return Math.floor(min);
}

async function renderHome(level) {
  $("#exambar").hidden = true;
  await useLevel(level || recall("hsk-level") || "hsk4");
  ATTEMPTS = await api("/api/attempts").catch(() => []);
  const saved = recall("hsk-exam");
  const tabs = LEVELS.map((l) => `<a href="#/${l.level}" class="tab ${l.level === CFG.level ? "on" : ""}">${esc(l.short)}</a>`).join("");
  const mins = (k) => { const s = sectionCfg(k); return s.minutes ? `${(s.readMinutes || 0) + s.minutes} min` : "~30 min"; };
  const total = CFG.sections.reduce((s, x) => s + (x.minutes ? x.minutes + (x.readMinutes || 0) : 35), 0);
  let html = `<nav class="tabs">${tabs}</nav><h1>${esc(CFG.name)}模拟考试</h1>
    <p class="muted">每次随机组卷 · every paper is drawn at random from the bank, preferring questions you haven't seen. Bank ≈ ${papersAvailable()} full papers.</p>`;
  if (saved) html += `<div class="notice">有一份未完成的试卷 · You have an unfinished ${esc((LEVELS.find((l) => l.level === saved.level) || {}).short || "")} paper (${esc(saved.mode)}). <button class="btn small" id="resume">继续 Resume</button> <button class="btn small" id="discard">放弃 Discard</button></div>`;
  html += `<div class="cards"><button class="card" data-mode="full"><div class="t">完整考试</div><div class="d">Full exam · ${CFG.sections.reduce((s, x) => s + x.count, 0)} 题 · ~${total} min</div></button>
    ${CFG.sections.map((s) => `<button class="card" data-mode="${s.key}"><div class="t">${esc(s.name.split(" ")[0])}</div><div class="d">${esc(s.name.split(" ").slice(1).join(" "))} · ${s.count} 题 · ${mins(s.key)}</div></button>`).join("")}</div>
    <label class="opts"><input type="checkbox" id="practice"> 练习模式 · practice mode (no timer, replay audio freely)</label>
    <h2>历史成绩 · History</h2>`;
  const mine = ATTEMPTS.filter((a) => (a.level || "hsk4") === CFG.level);
  if (!mine.length) html += `<p class="muted">No ${esc(CFG.short)} attempts yet.</p>`;
  else {
    html += `<table class="hist"><tr><th>日期</th><th>类型</th>${CFG.sections.map((s) => `<th>${esc(s.name.split(" ")[0])}</th>`).join("")}<th>总分</th></tr>`;
    for (const a of mine) {
      const s = computeScores(a);
      const cell = (k) => s[k] ? (s[k].score ?? `${s[k].provisional}+?`) : "—";
      const full = a.sections.length === CFG.sections.length;
      const total = full && CFG.sections.every((x) => s[x.key].score !== null) ? CFG.sections.reduce((t, x) => t + s[x.key].score, 0) : null;
      const tot = full ? (total === null ? `<span class="pill wait">待批改</span>` : `${total} <span class="pill ${total >= CFG.pass ? "pass" : "fail"}">${total >= CFG.pass ? "合格" : "未合格"}</span>`) : "";
      html += `<tr data-id="${esc(a.id)}"><td>${new Date(a.finishedAt).toLocaleString()}</td><td>${esc(a.mode)}${a.practice ? " · 练习" : ""}</td>${CFG.sections.map((x) => `<td>${cell(x.key)}</td>`).join("")}<td>${tot}</td></tr>`;
    }
    html += `</table>`;
  }
  $("#app").innerHTML = html;
  $("#app").onclick = async (e) => {
    const c = e.target.closest("[data-mode]");
    if (c) {
      try { exam = buildPaper(c.dataset.mode, $("#practice").checked); } catch (err) { $("#app").insertAdjacentHTML("afterbegin", `<div class="notice">${esc(err.message)}</div>`); return; }
      save(); location.hash = "#/exam"; return;
    }
    const r = e.target.closest("tr[data-id]");
    if (r) location.hash = `#/result/${r.dataset.id}`;
    if (e.target.id === "resume") { exam = saved; location.hash = "#/exam"; }
    if (e.target.id === "discard") { store("hsk-exam", null); renderHome(CFG.level); }
  };
  $("#app").oninput = $("#app").onchange = null;
}

// ---------- results ----------
async function renderResult(id) {
  $("#exambar").hidden = true;
  clearTimeout(pollTimer);
  const a = await api(`/api/attempts/${id}`);
  await useLevel(a.level || "hsk4");
  const s = computeScores(a);
  const full = a.sections.length === CFG.sections.length;
  const total = full && CFG.sections.every((x) => s[x.key].score !== null) ? CFG.sections.reduce((t, x) => t + s[x.key].score, 0) : null;
  let html = `<p><a href="#/${CFG.level}">← 返回 ${esc(CFG.short)}</a></p><h1>成绩 · Results</h1><p class="muted">${esc(CFG.name)} · ${new Date(a.finishedAt).toLocaleString()} · ${esc(a.mode)}${a.practice ? " · 练习模式" : ""}</p><div class="scores">`;
  for (const key of a.sections) {
    const v = s[key], S = sectionCfg(key);
    const val = v.score === null ? `${v.provisional}<small> + ? / 100</small>` : `${v.score}<small> / 100</small>`;
    const sub = key !== "writing" ? `${v.right}/${v.of} correct` : v.free === null ? `auto ${v.auto} · Claude grading pending` : `auto ${v.auto} + Claude ${v.free}`;
    html += `<div class="score"><div class="k">${S.name}</div><div class="v">${val}</div><div class="small muted">${sub}</div></div>`;
  }
  if (full) html += `<div class="score total"><div class="k">总分 Total</div><div class="v">${total ?? "…"}<small> / ${CFG.sections.length * 100}</small></div><div class="small muted">${total === null ? "writing pending" : total >= CFG.pass ? `合格 pass (≥${CFG.pass})` : `未合格 below ${CFG.pass}`}</div></div>`;
  html += `</div>`;
  const hasFree = a.questions.some((q) => partCfg(q.part).type === "free");
  if (hasFree && !a.claudeGrade) html += `<div class="notice">书写 is waiting for grading. In Claude Code (in <code>~/Desktop/hsk</code>) say: <code>grade my HSK writing</code>. This page updates by itself when the grade arrives.</div>`;
  for (const key of a.sections) {
    html += `<h2>${sectionCfg(key).name}</h2>`;
    for (const q of a.questions.filter((x) => sectionOf(x.qnum) === key)) html += reviewQ(a, q);
  }
  $("#app").innerHTML = html;
  $("#app").onclick = (e) => { const t = e.target.closest("[data-play]"); if (t) playOnce(t.dataset.play); };
  if (hasFree && !a.claudeGrade) {
    const poll = async () => {
      if (location.hash !== `#/result/${id}`) return;
      const fresh = await api(`/api/attempts/${id}`).catch(() => null);
      if (fresh && fresh.claudeGrade) renderResult(id); else pollTimer = setTimeout(poll, 10000);
    };
    pollTimer = setTimeout(poll, 10000);
  }
}

function transcript(u, q) {
  const who = { m: "男", f: "女", m2: "男", f2: "女", n: "问" };
  const body = u.dialogue ? u.dialogue.map((d) => `${who[d.s] || ""}：${d.t}`).join("\n") : u.passage || "";
  if (u.statement !== undefined) return `${body}\n★ ${u.statement}`;
  if (u.questions) return `${body}\n问：${u.questions[q.sub].question}`;
  return u.question ? `${body}\n问：${u.question}` : body;
}

function reviewQ(a, q) {
  const u = unit(q.unitId), part = partCfg(q.part);
  if (!u) return `<div class="rv"><span class="qn">${q.qnum}.</span> <span class="muted">(item ${esc(q.unitId)} no longer in bank)</span></div>`;
  const ok = isCorrect(q), cls = ok === null ? "" : ok ? "right" : "wrong", mark = ok === null ? "" : ok ? "✓" : "✗";
  const b = a.blocks.find((x) => x.unitId === q.unitId);
  const listening = part.section === "listening";
  const opt = (opts, di) => di === null || di === undefined ? "—" : `${LET[di]} ${opts[q.optOrder[di]]}`;
  const ans = (mine, right) => `<div class="ans">你的答案：${esc(mine)} · 正确：${esc(right)}</div>`;
  let body = "";
  switch (part.type) {
    case "tf": body = `<span class="stmt">★ ${esc(u.statement)}</span>` + ans(q.response === null ? "—" : q.response ? "对" : "错", q.correct ? "对" : "错"); break;
    case "mcq":
      body = (!listening && u.passage ? `<div class="passage">${blanks(u.passage, (k) => `<b>${CIRCLED[k - 1]}</b>____`)}</div>` : "") +
        (!part.noQuestion && u.question ? `<span class="stmt">${esc(u.question)}</span>` : "") + ans(opt(u.options, q.response), opt(u.options, q.correct)) +
        (u.explain ? `<div class="fb">${esc(u.explain.replace(/^[A-D]\s+/, ""))}</div>` : "");
      break;
    case "mcq_group": {
      const Q = u.questions[q.sub];
      body = (Q.question ? `<span class="stmt">★ ${esc(Q.question)}</span>` : "") + ans(opt(Q.options, q.response), opt(Q.options, q.correct));
      if (!listening && q.qnum === b.qnums[0]) body += `<details><summary>原文 passage</summary><div class="transcript">${esc(u.passage.replace(/\[(\d+)\]/g, (_, k) => `（${b.qnums[k - 1]}）`))}</div></details>`;
      break;
    }
    case "wordbank": { const w = (L) => L ? `${L} ${u.bank[b.bankOrder[LET.indexOf(L)]]}` : "—"; body = `<span class="passage">${esc(u.items[q.sub].text)}</span>` + ans(w(q.response), w(q.correct)); break; }
    case "insert": { const w = (L) => L ? `${L} ${u.sentences[b.sentOrder[LET.indexOf(L)]]}` : "—"; body = ans(w(q.response), w(q.correct)); break; }
    case "order": body = b.order.map((k, di) => `<div class="orderline"><span class="L">${LET[di]}</span>${esc(u[k])}</div>`).join("") + ans(q.response || "—", q.correct); break;
    case "arrange": body = `<div class="ans">你的答案：${esc(q.response || "—")}<br>正确：${esc(q.correct)}${(q.accepted || []).length ? ` <span class="muted">（也可：${esc(q.accepted.join(" / "))}）</span>` : ""}</div>`; break;
    case "free": {
      const g = a.claudeGrade && a.claudeGrade.items.find((x) => x.qnum === q.qnum);
      const pic = ["picture_sentence", "essay_picture"].includes(part.kind) ? `<img src="${image(u.id)}" alt="">` : "";
      const head = part.kind === "picture_sentence" ? `<div class="word">${esc(u.word)}</div>` : part.kind === "essay_words" ? `<div class="bank">${u.words.map((w) => `<span>${esc(w)}</span>`).join("")}</div>` : "";
      const models = u.models ? u.models.join("\n") : u.model || "";
      body = `<div class="${pic ? "w2" : ""}">${pic}<div>${head}<div class="passage">${esc(q.response || "—")}</div><div class="small muted">${hanCount(q.response)} 字${part.targetChars ? ` / 目标 ${part.targetChars}` : ""}</div>
        ${g ? `<div class="fb"><b>${g.score}/${part.points}</b> · ${esc(g.feedback)}${g.corrected ? `<br>修改：${esc(g.corrected)}` : ""}</div>` : `<div class="small muted">待批改 · waiting for Claude</div>`}
        ${models ? `<details><summary>参考答案 model answer</summary><div class="transcript">${esc(models)}</div></details>` : ""}
        ${u.story ? `<details><summary>原文 source story</summary><div class="transcript">${esc(u.title ? u.title + "\n" : "")}${esc(u.story)}</div></details>` : ""}</div></div>`;
      break;
    }
  }
  let extra = "";
  if (listening) {
    extra = `<details><summary>听力原文 transcript</summary><div class="transcript">${esc(transcript(u, q))}</div><button class="playbtn" data-play="${audio(u.id)}">▶ 播放</button></details>`;
  }
  return `<div class="rv ${cls}"><span class="mark">${mark}</span><span class="qn">${q.qnum}.</span>${body}${extra}</div>`;
}

// ---------- router ----------
async function route() {
  clearInterval(tick);
  window.scrollTo(0, 0);
  stopAudio();
  const h = location.hash;
  if (h.startsWith("#/exam")) {
    exam = exam || recall("hsk-exam");
    if (!exam) { location.hash = "#/"; return; }
    await useLevel(exam.level || "hsk4");
    renderExam();
  } else if (h.startsWith("#/result/")) await renderResult(h.split("/")[2]);
  else await renderHome(h.split("/")[1] || null);
}

(async function init() {
  try { LEVELS = await api("/api/levels"); }
  catch (e) { $("#app").innerHTML = `<div class="notice">Start the server first: <code>.venv/bin/python server.py</code></div>`; return; }
  window.addEventListener("hashchange", route);
  route();
})();
