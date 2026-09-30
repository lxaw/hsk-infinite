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
  const min = Math.min(...part.questionsPerUnit);
  const fill = (order) => {
    let left = part.questions; const out = [];
    for (const u of order) {
      const n = nQuestions(part, u);
      if (n <= left && (left - n === 0 || left - n >= min)) { out.push(u); left -= n; }
      if (!left) return out;
    }
    return null;
  };
  // Among least-used fills, prefer group sizes that are still plentiful, so a scarce size
  // (e.g. the one 3-blank passage each paper needs) isn't used up early and items repeat sooner.
  const low = Math.min(...pool.map((u) => used[u.id] || 0));
  const avail = {};
  for (const u of pool) if ((used[u.id] || 0) === low) avail[nQuestions(part, u)] = (avail[nQuestions(part, u)] || 0) + 1;
  const cost = (out) => [out.reduce((s, u) => s + (used[u.id] || 0), 0), out.reduce((s, u) => s + 1 / (avail[nQuestions(part, u)] || 1), 0)];
  let best = null, bestCost = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const out = fill(byUsage(pool, used));
    if (!out) continue;
    const c = cost(out);
    if (!best || c[0] < bestCost[0] || (c[0] === bestCost[0] && c[1] < bestCost[1])) { best = out; bestCost = c; }
  }
  if (best) return best;
  for (let attempt = 0; attempt < 200; attempt++) { const out = fill(shuffle(pool)); if (out) return out; }
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
      // HSK 2.0 banks have a worked example; HSK 3.0 banks have none and one distractor word instead.
      const exAns = u.example ? u.example.answer : -1;
      const bankHtml = b.bankOrder.map((bi, di) => `<span class="${bi === exAns ? "used" : ""}"><span class="L">${LET[di]}</span>${esc(u.bank[bi])}</span>`).join("");
      const sel = (q) => `<select data-q="${q.qnum}"><option value="">—</option>${b.bankOrder.map((bi, di) => bi === exAns ? "" : `<option ${q.response === LET[di] ? "selected" : ""}>${LET[di]}</option>`).join("")}</select>`;
      const example = u.example ? `<div class="q"><span class="qn muted">例如：</span><span class="passage">${esc(u.example.text.replace("（ ）", `（ ${LET[b.bankOrder.indexOf(exAns)]} ）`))}</span></div>` : "";
      return `<div class="bank">${bankHtml}</div>
        ${example}
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
  if (part.kind === "essay_topic")
    return `<div class="q" id="q${q.qnum}"><span class="qn">${q.qnum}.</span><span class="stmt">${esc(u.task)}</span>${box}</div>`;
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
  const modeText = exam.drill ? "单项练习 drill · 每题可检查 check each item as you go" : exam.practice ? "练习模式 practice (replay allowed, no timer)" : exam.examDay ? "模拟考试日 exam day · 不能暂停 no pausing" : "考试模式 exam mode";
  const range = exam.drill ? `${exam.questions[0].qnum}–${exam.questions[exam.questions.length - 1].qnum}` : `${S.first}${S.count > 1 ? `–${S.first + S.count - 1}` : ""}`;
  let html = `<h1>${S.name}</h1><p class="muted">${CFG.name} · 第 ${range} 题 · ${modeText}</p>`;
  if (exam.examDay && exam.leftCount) html += `<div class="notice">已离开考试页面 ${exam.leftCount} 次 · you left the exam page ${exam.leftCount}× (recorded on the result)</div>`;
  if (key === "listening" && !exam.practice) {
    const resume = exam.examDay ? "继续 Resume · 从下一题开始 from the next question" : "继续 Resume";
    html += `<div class="player" id="player"><button class="btn primary small" id="startAudio">${exam.listenState ? resume : "开始 Start listening"}</button>
      <span id="nowPlaying" class="small muted">音频只播放一次 · audio plays once, like the real exam</span><div class="bar"><i id="pbar"></i></div></div>`;
  }
  for (const g of partGroups(key))
    html += `<section class="part"><div class="ph">${esc(g.head.title || "")}</div><div class="pd">${esc(g.head.desc || "")}</div>${g.blocks.map(drillBlock).join("")}</section>`;
  html += `<p><button class="btn primary" id="finishBottom">交卷 · Finish ${exam.drill ? "drill" : S.name}</button></p>`;
  $("#app").innerHTML = html;
  bindExam();
  startTimer();
  lockListeningFinish();
}

// Drill mode: each block gets a Check button; once checked, its answers lock and the review shows.
function drillBlock(b) {
  if (!exam.drill) return renderBlock(b);
  const i = exam.blocks.indexOf(b);
  if (!b.checked) return `<div class="blk">${renderBlock(b)}</div><p class="checkrow"><button class="btn small" data-check="${i}">检查 · Check</button></p>`;
  return `<fieldset class="blk" disabled>${renderBlock(b)}</fieldset><div class="drillfb">${b.qnums.map((n) => reviewQ(exam, qById(n))).join("")}</div>`;
}

// Exam day: no finishing the listening section while the recording is still running.
function lockListeningFinish() {
  const running = exam.examDay && exam.sections[exam.secIndex] === "listening" && !(exam.listenState && exam.listenState.done);
  [$("#finishSection"), $("#finishBottom")].filter(Boolean).forEach((b) => { b.disabled = running; b.title = running ? "听力录音结束后才能交卷 · available when the recording ends" : ""; });
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
    } else if (t.dataset.check) {
      const y = window.scrollY;
      exam.blocks[+t.dataset.check].checked = true; save();
      renderExam(); window.scrollTo(0, y);
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
function playOnce(src) { stopAudio(); player = new Audio(src); player.play().catch(() => {}); }  // interrupted plays are fine

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
  // Exam day never rewinds: an interrupted recording resumes at the next question's announcement.
  if (exam.examDay && exam.listenState && exam.listenState.i > 0 && !exam.listenState.done) {
    let j = exam.listenState.i + 1;
    while (j < seq.length && !(seq[j].src && seq[j].src.includes("/num"))) j++;
    exam.listenState.i = Math.min(j, seq.length);
  }
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
      exam.listenState.done = true;
      exam.deadline = Date.now() + review * 60000; save(); startTimer(); lockListeningFinish();
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

// ---------- drills ----------
// A drill is one part group of a normal paper (so question numbers and scoring stay real), always untimed.
function buildDrill(partId) {
  const part = partCfg(partId);
  const paper = buildPaper(part.section, true);
  const inGroup = (id) => partCfg(id).group === part.group;
  paper.blocks = paper.blocks.filter((b) => inGroup(b.part));
  paper.questions = paper.questions.filter((q) => inGroup(q.part));
  return { ...paper, mode: `drill:${part.group}`, drill: part.group };
}

function shortDesc(p) {
  const L = p.section === "listening", group = allParts().filter((x) => x.group === p.group);
  if (p.type === "tf") return "true / false";
  if (p.type === "wordbank") return "word bank";
  if (p.type === "order") return "put A B C in order";
  if (p.type === "insert") return "sentence insertion";
  if (p.type === "arrange") return "arrange the words";
  if (p.type === "free") return { picture_sentence: "picture + word → sentence", essay_topic: "short essay on a topic", essay_words: "short essays", essay_picture: "short essays", summary: "缩写 summary" }[p.kind] || "writing";
  if (p.cloze) return "cloze passages";
  if (p.type === "mcq_group") return L ? (group.some((x) => (x.questionsPerUnit || []).includes(5)) ? "interviews" : "long dialogues & passages") : "reading passages";
  if (L) return group.length > 1 ? "dialogues & passages" : "short items";
  const u = (BANK[p.id] || [])[0] || {};
  return u.errorType ? "病句 find the faulty sentence" : /\[\d\]/.test(u.passage || "") ? "word-set cloze" : u.question ? "short passages" : "match the statement";
}

function modeLabel(a) {
  const cfg = LEVELS.find((l) => l.level === (a.level || "hsk4")) || CFG;
  if (a.drill) {
    const p = allParts(cfg).find((x) => x.group === a.drill);
    return `单项 drill · ${sectionCfg(p.section, cfg).name.split(" ")[0]} ${p.title || ""}`;
  }
  const base = a.mode === "full" ? "完整 full" : (sectionCfg(a.mode, cfg) || { name: a.mode }).name.split(" ")[0];
  return base + (a.examDay ? " · 考试日" : a.practice ? " · 练习" : "");
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
  const mins = (k) => { const s = sectionCfg(k); return s.minutes ? `${(s.readMinutes || 0) + s.minutes} min` : `~${s.approxMinutes || 30} min`; };
  const total = CFG.sections.reduce((s, x) => s + (x.minutes ? x.minutes + (x.readMinutes || 0) : x.approxMinutes || 35), 0);
  let html = `<nav class="tabs">${tabs}</nav><h1>${esc(CFG.name)}模拟考试</h1>
    <p class="muted">每次随机组卷 · every paper is drawn at random from the bank, preferring questions you haven't seen. Bank ≈ ${papersAvailable()} full papers.</p>${CFG.note ? `<p class="small muted">${esc(CFG.note)}</p>` : ""}`;
  if (saved) html += `<div class="notice">有一份未完成的试卷 · You have an unfinished ${esc((LEVELS.find((l) => l.level === saved.level) || {}).short || "")} paper (${esc(saved.mode)}). <button class="btn small" id="resume">继续 Resume</button> <button class="btn small" id="discard">放弃 Discard</button></div>`;
  html += `<div class="cards"><button class="card" data-mode="full"><div class="t">完整考试</div><div class="d">Full exam · ${CFG.sections.reduce((s, x) => s + x.count, 0)} 题 · ~${total} min</div></button>
    ${CFG.sections.map((s) => `<button class="card" data-mode="${s.key}"><div class="t">${esc(s.name.split(" ")[0])}</div><div class="d">${esc(s.name.split(" ").slice(1).join(" "))} · ${s.count} 题 · ${mins(s.key)}</div></button>`).join("")}</div>
    <label class="opts"><input type="checkbox" id="practice"> 练习模式 · practice mode (no timer, replay audio freely)</label>
    <div class="tools">
      <a class="btn" href="#/examday/${CFG.level}">🎯 模拟考试日 · Exam day</a>
      <a class="btn" href="#/progress/${CFG.level}">📈 进度 · Progress</a>
      <a class="btn" href="#/words/${CFG.level}">📝 生词本 · Missed words</a>
      ${CFG.speaking ? `<a class="btn" href="#/speaking/${CFG.level}">🎤 口语 · Speaking</a>` : ""}
    </div>
    <h2>单项练习 · Drill one part</h2>
    <p class="muted small">One part of a paper, untimed. Check each item as you go to see the answer, transcript or explanation.</p>
    <div class="drills">${CFG.sections.map((s) => `<div class="drillsec"><div class="k">${esc(s.name.split(" ")[0])}</div>${s.parts.filter((p, i, arr) => arr.findIndex((x) => x.group === p.group) === i).map((p) => `<button class="drill" data-drill="${p.id}"><b>${esc(p.title || p.id)}</b> <span>${esc(shortDesc(partCfg(p.id)))}</span></button>`).join("")}</div>`).join("")}</div>
    <h2>历史成绩 · History</h2>`;
  const mine = ATTEMPTS.filter((a) => (a.level || "hsk4") === CFG.level);
  if (!mine.length) html += `<p class="muted">No ${esc(CFG.short)} attempts yet.</p>`;
  else {
    html += `<table class="hist"><tr><th>日期</th><th>类型</th>${CFG.sections.map((s) => `<th>${esc(s.name.split(" ")[0])}</th>`).join("")}<th>总分</th></tr>`;
    for (const a of mine) {
      const s = computeScores(a);
      // Drills show right/total in their section's column so a 10-question drill doesn't read as a section score.
      const cell = (k) => !s[k] ? "—" : a.drill ? (s[k].right !== undefined ? `${s[k].right}/${s[k].of}` : s[k].score ?? `${s[k].provisional}+?`) : (s[k].score ?? `${s[k].provisional}+?`);
      const full = a.sections.length === CFG.sections.length;
      const total = full && CFG.sections.every((x) => s[x.key].score !== null) ? CFG.sections.reduce((t, x) => t + s[x.key].score, 0) : null;
      const tot = full ? (total === null ? `<span class="pill wait">待批改</span>` : `${total} <span class="pill ${total >= CFG.pass ? "pass" : "fail"}">${total >= CFG.pass ? "合格" : "未合格"}</span>`) : "";
      html += `<tr data-id="${esc(a.id)}"><td>${new Date(a.finishedAt).toLocaleString()}</td><td>${esc(modeLabel(a))}</td>${CFG.sections.map((x) => `<td>${cell(x.key)}</td>`).join("")}<td>${tot}</td></tr>`;
    }
    html += `</table>`;
  }
  $("#app").innerHTML = html;
  $("#app").onclick = async (e) => {
    const c = e.target.closest("[data-mode]"), d = e.target.closest("[data-drill]");
    if (c || d) {
      try { exam = d ? buildDrill(d.dataset.drill) : buildPaper(c.dataset.mode, $("#practice").checked); } catch (err) { $("#app").insertAdjacentHTML("afterbegin", `<div class="notice">${esc(err.message)}</div>`); return; }
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
  let html = `<p class="noprint"><a href="#/${CFG.level}">← 返回 ${esc(CFG.short)}</a> · <a href="#/sheet/${esc(a.id)}">🖨 答题卡 answer sheet</a> · <a href="#/words/${CFG.level}">📝 生词本 missed words</a></p>
    <h1>成绩 · Results</h1><p class="muted">${esc(CFG.name)} · ${new Date(a.finishedAt).toLocaleString()} · ${esc(modeLabel(a))}</p>`;
  if (a.examDay) html += `<div class="notice">${a.leftCount ? `考试期间离开页面 ${a.leftCount} 次 · you left the exam page ${a.leftCount}× during this paper.` : "考试期间没有离开页面 · you stayed on the exam page the whole time."}</div>`;
  html += `<div class="scores">`;
  for (const key of a.sections) {
    const v = s[key], S = sectionCfg(key);
    const val = v.score === null ? `${v.provisional}<small> + ? / 100</small>` : `${v.score}<small> / 100</small>`;
    const sub = key !== "writing" ? `${v.right}/${v.of} correct` : v.free === null ? `auto ${v.auto} · Claude grading pending` : `auto ${v.auto} + Claude ${v.free}`;
    html += `<div class="score"><div class="k">${S.name}</div><div class="v">${val}</div><div class="small muted">${sub}</div></div>`;
  }
  if (full) html += `<div class="score total"><div class="k">总分 Total</div><div class="v">${total ?? "…"}<small> / ${CFG.sections.length * 100}</small></div><div class="small muted">${total === null ? "writing pending" : total >= CFG.pass ? `合格 pass (≥${CFG.pass}${CFG.passEstimated ? ", estimated" : ""})` : `未合格 below ${CFG.pass}${CFG.passEstimated ? " (estimated)" : ""}`}</div></div>`;
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
      const head = part.kind === "picture_sentence" ? `<div class="word">${esc(u.word)}</div>` : part.kind === "essay_topic" ? `<div class="stmt">${esc(u.task)}</div>` : part.kind === "essay_words" ? `<div class="bank">${u.words.map((w) => `<span>${esc(w)}</span>`).join("")}</div>` : "";
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

// ---------- exam day ----------
async function renderExamDay(level) {
  $("#exambar").hidden = true;
  await useLevel(level);
  const saved = recall("hsk-exam");
  const mine = saved && saved.examDay && !saved.started && saved.level === CFG.level;
  if (saved && !mine) {
    $("#app").innerHTML = `<p><a href="#/${CFG.level}">← 返回 ${esc(CFG.short)}</a></p><h1>模拟考试日 · Exam day</h1>
      <div class="notice">你有一份未完成的试卷 · You have an unfinished paper. Setting up exam day discards it.
      <button class="btn small" id="resume">继续那份 Resume it</button> <button class="btn small" id="discard">放弃并继续 Discard & continue</button></div>`;
    $("#app").onclick = (e) => {
      if (e.target.id === "resume") { exam = saved; location.hash = "#/exam"; }
      if (e.target.id === "discard") { store("hsk-exam", null); renderExamDay(level); }
    };
    return;
  }
  if (mine) exam = saved;
  else {
    try { exam = { ...buildPaper("full", false), examDay: true, started: false, leftCount: 0 }; } catch (err) { $("#app").innerHTML = `<div class="notice">${esc(err.message)}</div>`; return; }
    save();
  }
  const row = (s) => `<tr><td>${esc(s.name)}</td><td>${s.count} 题</td><td>${s.minutes ? `${(s.readMinutes || 0) + s.minutes} min${s.readMinutes ? ` (阅读 ${s.readMinutes} + 写 ${s.minutes})` : ""}` : `~${s.approxMinutes ? s.approxMinutes - (s.reviewMinutes || 3) : sectionCfg(s.key).count > 40 ? 35 : 30} min + ${s.reviewMinutes || 3} min 检查`}</td></tr>`;
  const total = CFG.sections.reduce((t, s) => t + (s.minutes ? s.minutes + (s.readMinutes || 0) : s.approxMinutes || 35), 0);
  const items = [
    ["sound", "耳机或音箱已测试 · headphones/speakers tested", `<button class="btn small" id="soundTest">▶ 试音 Sound test</button>`],
    ["quiet", "安静的房间，手机静音、关闭通知 · quiet room, phone silenced, notifications off", ""],
    ["time", `预留完整时间 · I have about ${total + 10} minutes free`, ""],
    ["paper", "准备好草稿纸和笔 · scrap paper and a pen ready", `<a class="btn small" href="#/sheet/current" target="_blank">🖨 打印空白答题卡 Print a blank answer sheet (optional)</a>`],
    ["rules", "我知道：开始后不能暂停；听力只放一遍；每部分时间到自动交卷 · no pausing, the recording plays once, each section ends automatically", ""],
  ];
  $("#app").innerHTML = `<p><a href="#/${CFG.level}">← 返回 ${esc(CFG.short)}</a></p><h1>模拟考试日 · Exam day</h1>
    <p class="muted">${esc(CFG.name)} · 完整试卷 full paper under real conditions · ${CFG.sections.reduce((s, x) => s + x.count, 0)} 题 · 合格 ${CFG.pass}/${CFG.sections.length * 100}</p>
    <table class="hist"><tr><th>部分 Section</th><th>题数</th><th>时间 Time</th></tr>${CFG.sections.map(row).join("")}</table>
    <h2>考前检查 · Before you start</h2>
    <div class="checklist">${items.map(([k, t, extra]) => `<label class="ck"><input type="checkbox" data-ck="${k}" ${k === "sound" ? "disabled" : ""}> <span>${esc(t)}</span> ${extra}</label>`).join("")}</div>
    <ul class="small muted rules"><li>听力一旦开始就会连续播放；如果页面中断，点“继续”会从下一题开始，不会重放。If the page is interrupted, the recording resumes at the next question, never rewinds.</li>
    <li>听力录音结束前不能交卷 · the listening section can't be finished before the recording ends.</li>
    <li>离开考试页面的次数会被记录 · leaving the exam tab is counted and shown on the result.</li></ul>
    <p><button class="btn primary" id="beginExam" disabled>开始考试 · Begin the exam</button></p>`;
  const boxes = [...document.querySelectorAll("[data-ck]")];
  const update = () => { $("#beginExam").disabled = !boxes.every((b) => b.checked || b.dataset.ck === "paper"); };
  $("#app").onchange = update;
  $("#app").onclick = (e) => {
    if (e.target.id === "soundTest") {
      playOnce(audio(`fixed/num${CFG.sections[0].first}`));
      const b = boxes.find((x) => x.dataset.ck === "sound"); b.disabled = false; b.checked = true; update();
    }
    if (e.target.id === "beginExam") { exam.started = true; exam.startedAt = new Date().toISOString(); save(); location.hash = "#/exam"; }
  };
}

// ---------- answer sheet (答题卡) ----------
async function renderSheet(id) {
  $("#exambar").hidden = true;
  const a = id === "current" ? recall("hsk-exam") : await api(`/api/attempts/${id}`).catch(() => null);
  if (!a) { $("#app").innerHTML = `<div class="notice">No paper found for this answer sheet.</div>`; return; }
  await useLevel(a.level || "hsk4");
  const filled = id !== "current";
  const bub = (label, on) => `<span class="bub ${on ? "on" : ""}">[${label}]</span>`;
  const cell = (q) => {
    const b = a.blocks.find((x) => x.qnums.includes(q.qnum)), part = partCfg(q.part), r = filled ? q.response : null;
    switch (part.type) {
      case "tf": return bub("✓", r === true) + bub("✗", r === false);
      case "wordbank": return b.bankOrder.map((_, di) => bub(LET[di], r === LET[di])).join("");
      case "insert": return b.sentOrder.map((_, di) => bub(LET[di], r === LET[di])).join("");
      case "order": return [0, 1, 2].map((i) => `<span class="box">${esc((r || "")[i] || "")}</span>`).join("");
      case "arrange": return `<span class="line">${esc(r || "")}</span>`;
      default: return q.optOrder ? q.optOrder.map((_, di) => bub(LET[di], r === di)).join("") : "";
    }
  };
  const grid = (q, part) => {
    const text = filled ? String(q.response || "").replace(/\s/g, "") : "";
    const cols = 20, rows = part.targetChars ? Math.ceil((part.targetChars * 1.25) / cols) : 2;
    let html = "";
    for (let r = 0; r < rows; r++) {
      html += `<div class="gr">${[...Array(cols)].map((_, c) => `<span>${esc(text[r * cols + c] || "")}</span>`).join("")}${((r + 1) * cols) % 100 === 0 ? `<i>${(r + 1) * cols}</i>` : ""}</div>`;
    }
    return `<div class="grid">${html}</div>`;
  };
  let html = `<p class="noprint"><a href="${filled ? `#/result/${esc(a.id)}` : `#/examday/${CFG.level}`}">← 返回</a> · <button class="btn small" id="print">🖨 打印 Print</button> <span class="small muted">${filled ? "filled in with your answers" : "blank sheet for this paper"}</span></p>
    <div class="sheet"><div class="sh-head"><b>汉语水平考试 ${esc(CFG.short)} 答题卡</b><span>姓名 Name ________________</span><span>试卷 Paper ${esc(a.id)}</span><span>日期 Date ${esc(filled ? new Date(a.finishedAt).toLocaleDateString() : "____________")}</span></div>`;
  for (const key of a.sections) {
    const qs = a.questions.filter((q) => sectionOf(q.qnum) === key);
    html += `<div class="sh-sec"><h3>${esc(sectionCfg(key).name)}</h3>`;
    const choice = qs.filter((q) => partCfg(q.part).type !== "free");
    if (choice.length) html += `<div class="sh-grid">${choice.map((q) => `<div class="sh-q"><span class="n">${q.qnum}.</span>${cell(q)}</div>`).join("")}</div>`;
    for (const q of qs.filter((x) => partCfg(x.part).type === "free")) html += `<div class="sh-free"><span class="n">${q.qnum}.</span>${grid(q, partCfg(q.part))}</div>`;
    html += `</div>`;
  }
  $("#app").innerHTML = html + `</div>`;
  $("#app").onclick = (e) => { if (e.target.id === "print") window.print(); };
}

// ---------- missed words (生词本) ----------
// Levels on the HSK 3.0 syllabus tag words with the 2025 lists (vocab_v3.json), the others with the 2012 lists.
let VOCAB = null, VOCAB_MAX = 1, VOCAB_FILE = "";
async function loadVocab() {
  const file = CFG.syllabus === "v3" ? "vocab_v3.json" : "vocab.json";
  if (VOCAB_FILE !== file) { VOCAB = await api(file); VOCAB_FILE = file; VOCAB_MAX = Math.min(8, Math.max(...Object.keys(VOCAB).map((w) => w.length))); }
  return VOCAB;
}
const levelNum = (cfg = CFG) => cfg.num || +cfg.level.replace(/\D/g, "");
// Forward maximum matching against the HSK word list: good enough to tag words, no dictionary server needed.
// SEG_SKIP are common compounds that aren't list words; matching them first stops 一个人 → 一 + 个人.
const SEG_SKIP = new Set("一个 这个 那个 每个 几个 两个 哪个 整个 一种 这种 那种 各种 一些 这些 那些 一天 一次 有人 没人".split(" "));
function segment(text) {
  const out = [];
  for (let i = 0; i < text.length;) {
    let hit = null;
    if (/[一-鿿]/.test(text[i])) for (let n = Math.min(VOCAB_MAX, text.length - i); n >= 1; n--) { const w = text.substr(i, n); if (VOCAB[w] || SEG_SKIP.has(w)) { hit = w; break; } }
    if (hit) { if (VOCAB[hit]) out.push(hit); i += hit.length; } else i++;
  }
  return out;
}
function filledPassage(u) {
  if (!u.passage) return "";
  return u.passage.replace(/\[(\d+)\]/g, (m, k) => {
    k = +k;
    if (u.questions && u.questions[k - 1]) { const Q = u.questions[k - 1]; return Q.options[Q.answer]; }
    if (u.sentences) return u.sentences[u.answers[k - 1]];
    if (u.options) return (u.options[u.answer].split("　")[k - 1]) || m;
    return m;
  });
}
function missedText(u, q, part) {
  const ctx = [filledPassage(u), u.dialogue ? u.dialogue.map((d) => d.t).join("\n") : ""].join("\n");
  switch (part.type) {
    case "tf": return { key: u.statement, ctx };
    case "mcq": return { key: u.errorType ? u.options.join("\n") : `${u.options[u.answer]}\n${u.question || ""}`, ctx };
    case "mcq_group": { const Q = u.questions[q.sub]; return { key: `${Q.options[Q.answer]}\n${Q.question || ""}`, ctx }; }
    case "wordbank": { const it = u.items[q.sub]; return { key: it.text.replace("（ ）", u.bank[it.answer]), ctx: "" }; }
    case "insert": return { key: u.sentences[u.answers[q.sub]], ctx };
    case "order": return { key: ["A", "B", "C"].map((k) => u[k]).join("\n"), ctx: "" };
    case "arrange": return { key: u.answer, ctx: "" };
  }
  return { key: "", ctx: "" };
}
function exampleFor(w, texts) {
  for (const t of texts) for (const s of t.split(/(?<=[。！？!?\n])/)) if (s.includes(w)) return s.trim().slice(0, 90);
  return "";
}
function collectMissed(level) {
  const L = levelNum(), words = {};
  for (const a of ATTEMPTS.filter((x) => (x.level || "hsk4") === level)) {
    for (const q of a.questions) {
      if (isCorrect(q) !== false) continue;
      const u = unit(q.unitId), part = partCfg(q.part);
      if (!u || !part) continue;
      const { key, ctx } = missedText(u, q, part);
      const found = [...segment(key).filter((w) => VOCAB[w][0] >= L - 1), ...segment(ctx).filter((w) => VOCAB[w][0] >= L)];
      for (const w of new Set(found)) {
        const e = (words[w] ||= { w, level: VOCAB[w][0], pinyin: VOCAB[w][1], gloss: VOCAB[w][2], n: 0, last: "", example: "" });
        e.n++;
        if (a.finishedAt > e.last) e.last = a.finishedAt;
        if (!e.example) e.example = exampleFor(w, [key, ctx]);
      }
    }
  }
  return Object.values(words);
}
async function renderWords(level) {
  $("#exambar").hidden = true;
  await useLevel(level);
  ATTEMPTS = await api("/api/attempts").catch(() => []);
  await loadVocab();
  const all = collectMissed(CFG.level);
  const known = new Set(recall("hsk-known-words") || []);
  const st = { lvl: 0, showKnown: false, sort: "n" };
  const draw = () => {
    let list = all.filter((e) => (!st.lvl || e.level === st.lvl) && (st.showKnown || !known.has(e.w)));
    list.sort(st.sort === "level" ? (x, y) => y.level - x.level || y.n - x.n : st.sort === "recent" ? (x, y) => y.last.localeCompare(x.last) || y.n - x.n : (x, y) => y.n - x.n || y.level - x.level);
    const counts = [1, 2, 3, 4, 5, 6].map((l) => [l, all.filter((e) => e.level === l && (st.showKnown || !known.has(e.w))).length]).filter(([, c]) => c);
    const hl = (s, w) => esc(s).split(esc(w)).join(`<mark>${esc(w)}</mark>`);
    $("#wordsBody").innerHTML = `<div class="opts">
        <span class="chips"><button class="chip ${!st.lvl ? "on" : ""}" data-lvl="0">全部 all</button>${counts.map(([l, c]) => `<button class="chip ${st.lvl === l ? "on" : ""}" data-lvl="${l}">HSK ${l} · ${c}</button>`).join("")}</span>
        <label>排序 <select id="wsort"><option value="n" ${st.sort === "n" ? "selected" : ""}>次数 most missed</option><option value="level" ${st.sort === "level" ? "selected" : ""}>级别 level</option><option value="recent" ${st.sort === "recent" ? "selected" : ""}>最近 recent</option></select></label>
        <label><input type="checkbox" id="wknown" ${st.showKnown ? "checked" : ""}> 显示已掌握 show known (${known.size})</label>
        <button class="btn small" id="wexport" ${list.length ? "" : "disabled"}>⬇ 导出 Anki (${list.length})</button></div>
      ${list.length ? `<table class="words"><tr><th>词语</th><th>拼音 · 意思</th><th>级别</th><th>错</th><th>例句 example</th><th></th></tr>
        ${list.map((e) => `<tr class="${known.has(e.w) ? "known" : ""}"><td class="w">${esc(e.w)}</td><td><div>${esc(e.pinyin)}</div><div class="small muted">${esc(e.gloss)}</div></td><td><span class="pill lv">HSK ${e.level}</span></td><td>${e.n}×</td><td class="small">${hl(e.example, e.w)}</td>
          <td><button class="btn small" data-known="${esc(e.w)}" title="${known.has(e.w) ? "放回生词本 back to the list" : "我会了 mark as known"}">${known.has(e.w) ? "↺" : "✓"}</button></td></tr>`).join("")}</table>`
        : `<p class="muted">${all.length ? "Nothing to show with these filters." : `No missed words yet. Words come from questions you got wrong in ${esc(CFG.short)} papers and drills.`}</p>`}`;
    st.list = list;
  };
  $("#app").innerHTML = `<p><a href="#/${CFG.level}">← 返回 ${esc(CFG.short)}</a></p><h1>生词本 · Missed words</h1>
    <p class="muted">${esc(CFG.short)} · words from the questions you got wrong, tagged by HSK level${CFG.syllabus === "v3" ? " on the 2025 (3.0) word lists" : ""} (the question's own words from HSK ${Math.max(1, levelNum() - 1)} up, longer passages from HSK ${levelNum()} up). Export makes a tab-separated file for Anki's File → Import.</p><div id="wordsBody"></div>`;
  draw();
  $("#app").onclick = (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.lvl !== undefined) { st.lvl = +t.dataset.lvl; draw(); }
    else if (t.dataset.known) { known.has(t.dataset.known) ? known.delete(t.dataset.known) : known.add(t.dataset.known); store("hsk-known-words", [...known]); draw(); }
    else if (t.id === "wexport") exportAnki(st.list);
  };
  $("#app").onchange = (e) => {
    if (e.target.id === "wsort") { st.sort = e.target.value; draw(); }
    if (e.target.id === "wknown") { st.showKnown = e.target.checked; draw(); }
  };
}
function exportAnki(list) {
  const f = (s) => String(s || "").replace(/[\t\r\n]+/g, " ");
  const lines = ["#separator:tab", "#html:true", "#columns:Word\tPinyin\tMeaning\tLevel\tExample\tTags", "#tags column:6",
    ...list.map((e) => [e.w, e.pinyin, f(esc(e.gloss)), `HSK ${e.level}`, f(esc(e.example)).split(esc(e.w)).join(`<b>${esc(e.w)}</b>`), `HSK${e.level} ${CFG.level}-missed`].map(f).join("\t"))];
  const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/tab-separated-values;charset=utf-8" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: `${CFG.level}-missed-words.txt` });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- progress ----------
function partStats(level, filter) {
  const rows = {};
  const list = ATTEMPTS.filter((a) => (a.level || "hsk4") === level && (filter === "all" || (filter === "exam" ? !a.practice : a.practice)))
    .sort((x, y) => x.finishedAt.localeCompare(y.finishedAt));
  for (const a of list) {
    const per = {};
    for (const q of a.questions) {
      const part = partCfg(q.part);
      if (!part) continue;
      const g = (per[part.group] ||= { right: 0, of: 0 });
      if (part.type === "free") {
        const gr = a.claudeGrade && a.claudeGrade.items.find((x) => x.qnum === q.qnum);
        if (gr) { g.right += Math.min(+gr.score || 0, part.points) / part.points; g.of++; }
      } else { g.of++; if (isCorrect(q)) g.right++; }
    }
    for (const [k, v] of Object.entries(per)) if (v.of) (rows[k] ||= []).push({ ...v, at: a.finishedAt });
  }
  return { rows, list };
}
function renderProgressChart(list) {
  const pts = list.filter((a) => !a.drill).map((a) => ({ a, s: computeScores(a) }));
  const secs = CFG.sections;
  if (pts.length < 2) return `<p class="muted small">The score chart appears after two full or section papers. ${pts.length ? "One so far." : ""}</p>`;
  const W = 760, H = 260, m = { l: 36, r: 90, t: 14, b: 30 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const x = (i) => m.l + (pts.length === 1 ? iw / 2 : (i * iw) / (pts.length - 1)), y = (v) => m.t + ih - (v / 100) * ih;
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Section scores over time">`;
  for (const v of [0, 20, 40, 60, 80, 100]) svg += `<line x1="${m.l}" x2="${m.l + iw}" y1="${y(v)}" y2="${y(v)}" class="gridl ${v === 60 ? "ref" : ""}"/><text x="${m.l - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${v}</text>`;
  svg += `<text x="${m.l + iw + 6}" y="${y(60) + 4}" class="axis">avg 60 = pass</text>`;
  const ticks = pts.length <= 8 ? pts.map((_, i) => i) : [0, Math.floor((pts.length - 1) / 2), pts.length - 1];
  for (const i of ticks) svg += `<text x="${x(i)}" y="${H - 8}" class="axis" text-anchor="middle">${new Date(pts[i].a.finishedAt).toLocaleDateString(undefined, { month: "numeric", day: "numeric" })}</text>`;
  const labels = [];
  secs.forEach((sec, si) => {
    let d = "", pen = false;
    const labelY = [];
    pts.forEach((p, i) => {
      const v = p.s[sec.key] && p.s[sec.key].score;
      if (v === null || v === undefined) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true; labelY.push([i, v]);
    });
    svg += `<path d="${d}" class="ser s${si + 1}"/>`;
    pts.forEach((p, i) => { const v = p.s[sec.key] && p.s[sec.key].score; if (v !== null && v !== undefined) svg += `<circle cx="${x(i)}" cy="${y(v)}" r="4" class="dot s${si + 1} ${p.a.practice ? "hollow" : ""}"/>`; });
    if (labelY.length) { const [i, v] = labelY[labelY.length - 1]; labels.push({ x: x(i) + 8, y: y(v) + 4, t: sec.name.split(" ")[0] }); }
  });
  // Direct labels at each line's last point, nudged apart so overlapping lines stay readable.
  labels.sort((a, b) => a.y - b.y);
  for (let k = 1; k < labels.length; k++) labels[k].y = Math.max(labels[k].y, labels[k - 1].y + 15);
  const over = labels.length ? labels[labels.length - 1].y - (m.t + ih + 4) : 0;
  for (const l of labels) svg += `<text x="${l.x}" y="${l.y - Math.max(0, over)}" class="lab">${esc(l.t)}</text>`;
  svg += `<line id="xhair" class="xhair" y1="${m.t}" y2="${m.t + ih}" x1="-10" x2="-10"/><rect id="hit" x="${m.l - 10}" y="${m.t}" width="${iw + 20}" height="${ih}" fill="transparent"/></svg>`;
  PROGRESS_POINTS = { pts, x, W };
  const legend = `<div class="legend">${secs.map((s, i) => `<span><i class="key s${i + 1}"></i>${esc(s.name.split(" ")[0])}</span>`).join("")}<span><i class="key hollowkey"></i>练习 practice</span></div>`;
  return legend + `<div class="chartwrap">${svg}<div id="tip" class="tip" hidden></div></div>`;
}
let PROGRESS_POINTS = null;
function bindChart() {
  const hit = $("#hit");
  if (!hit || !PROGRESS_POINTS) return;
  const { pts, x, W } = PROGRESS_POINTS, svg = hit.ownerSVGElement, tip = $("#tip");
  const show = (ev) => {
    const r = svg.getBoundingClientRect(), px = ((ev.clientX - r.left) / r.width) * W;
    let i = 0;
    pts.forEach((_, k) => { if (Math.abs(x(k) - px) < Math.abs(x(i) - px)) i = k; });
    $("#xhair").setAttribute("x1", x(i)); $("#xhair").setAttribute("x2", x(i));
    const p = pts[i];
    tip.replaceChildren();
    const head = document.createElement("div"); head.className = "small muted"; head.textContent = `${new Date(p.a.finishedAt).toLocaleString()} · ${modeLabel(p.a)}`; tip.append(head);
    CFG.sections.forEach((s, si) => {
      const v = p.s[s.key]; if (!v) return;
      const row = document.createElement("div"); const k = document.createElement("i"); k.className = `key s${si + 1}`;
      const b = document.createElement("b"); b.textContent = v.score === null ? `${v.provisional}+?` : v.score;
      row.append(k, b, ` ${s.name.split(" ")[0]}`); tip.append(row);
    });
    tip.hidden = false;
    const left = (x(i) / W) * r.width;
    tip.style.left = `${left > r.width / 2 ? Math.max(0, left - tip.offsetWidth - 12) : left + 12}px`;
  };
  hit.onpointermove = show;
  hit.onpointerleave = () => { tip.hidden = true; $("#xhair").setAttribute("x1", -10); $("#xhair").setAttribute("x2", -10); };
}
async function renderProgress(level) {
  $("#exambar").hidden = true;
  await useLevel(level);
  ATTEMPTS = await api("/api/attempts").catch(() => []);
  let filter = recall("hsk-progress-filter") || "all";
  const draw = () => {
    const { rows, list } = partStats(CFG.level, filter);
    const qs = Object.values(rows).flat();
    const answered = qs.reduce((s, r) => s + r.of, 0), right = qs.reduce((s, r) => s + r.right, 0);
    const fulls = list.filter((a) => a.sections.length === CFG.sections.length).map((a) => { const s = computeScores(a); return CFG.sections.every((x) => s[x.key].score !== null) ? CFG.sections.reduce((t, x) => t + s[x.key].score, 0) : null; }).filter((t) => t !== null);
    const pct = (r, o) => (o ? Math.round((100 * r) / o) : null);
    const groups = allParts().filter((p, i, arr) => arr.findIndex((x) => x.group === p.group) === i);
    const partRows = groups.map((p) => {
      const rs = rows[p.group] || [], o = rs.reduce((s, r) => s + r.of, 0), rt = rs.reduce((s, r) => s + r.right, 0);
      const recent = rs.slice(-3), ro = recent.reduce((s, r) => s + r.of, 0), rr = recent.reduce((s, r) => s + r.right, 0);
      return { p, o, acc: pct(rt, o), recent: pct(rr, ro), n: rs.length };
    });
    const weakest = partRows.filter((r) => r.o >= 5).sort((a, b) => a.acc - b.acc)[0];
    $("#progBody").innerHTML = `<div class="opts"><span class="chips">${[["all", "全部 all"], ["exam", "考试模式 exam mode"], ["practice", "练习 practice & drills"]].map(([k, t]) => `<button class="chip ${filter === k ? "on" : ""}" data-filter="${k}">${t}</button>`).join("")}</span></div>
      <div class="scores">
        <div class="score"><div class="k">试卷 Papers</div><div class="v">${list.length}</div><div class="small muted">${list.filter((a) => a.drill).length} drills</div></div>
        <div class="score"><div class="k">答题 Answered</div><div class="v">${answered}</div><div class="small muted">auto-scored + graded writing</div></div>
        <div class="score"><div class="k">正确率 Accuracy</div><div class="v">${answered ? pct(right, answered) : "—"}<small>${answered ? "%" : ""}</small></div><div class="small muted">all parts</div></div>
        <div class="score"><div class="k">最高总分 Best total</div><div class="v">${fulls.length ? Math.max(...fulls) : "—"}<small>${fulls.length ? ` / ${CFG.sections.length * 100}` : ""}</small></div><div class="small muted">${fulls.length ? `合格线 pass ${CFG.pass}` : "no graded full paper yet"}</div></div>
      </div>
      <h2>分数走势 · Section scores</h2>${renderProgressChart(list)}
      <h2>各部分 · By part</h2>
      ${weakest ? `<p class="small">最需要练习 · Weakest part: <b>${esc(sectionCfg(weakest.p.section).name.split(" ")[0])} ${esc(weakest.p.title || "")}</b> (${esc(shortDesc(weakest.p))}) at ${weakest.acc}%.</p>` : ""}
      <table class="hist parts"><tr><th>部分 Part</th><th>题数</th><th>正确率 accuracy</th><th>最近3次 last 3</th><th></th></tr>
      ${partRows.map((r) => `<tr><td><b>${esc(sectionCfg(r.p.section).name.split(" ")[0])} ${esc(r.p.title || "")}</b><div class="small muted">${esc(shortDesc(r.p))}</div></td><td>${r.o}</td>
        <td>${r.acc === null ? `<span class="muted">—</span>` : `<div class="meter"><i style="width:${r.acc}%"></i></div><span class="mv">${r.acc}%</span>`}</td>
        <td>${r.recent === null ? "—" : `${r.recent}%${r.n > 3 && r.acc !== null ? ` <span class="small muted">${r.recent > r.acc + 2 ? "↑" : r.recent < r.acc - 2 ? "↓" : "→"}</span>` : ""}`}</td>
        <td><button class="btn small" data-drill="${r.p.id}">练 Drill</button></td></tr>`).join("")}</table>
      <p class="small muted">Writing rows count Claude-graded answers as a fraction of full marks; ungraded writing is left out.</p>
      <details><summary>数据表 · Table of papers</summary><table class="hist"><tr><th>日期</th><th>类型</th>${CFG.sections.map((s) => `<th>${esc(s.name.split(" ")[0])}</th>`).join("")}</tr>
      ${list.filter((a) => !a.drill).map((a) => { const s = computeScores(a); return `<tr><td>${new Date(a.finishedAt).toLocaleString()}</td><td>${esc(modeLabel(a))}</td>${CFG.sections.map((x) => `<td>${s[x.key] ? s[x.key].score ?? `${s[x.key].provisional}+?` : "—"}</td>`).join("")}</tr>`; }).join("")}</table></details>`;
    bindChart();
  };
  $("#app").innerHTML = `<p><a href="#/${CFG.level}">← 返回 ${esc(CFG.short)}</a></p><h1>进度 · Progress</h1><p class="muted">${esc(CFG.name)} · scores over time and accuracy by part</p><div id="progBody"></div>`;
  draw();
  $("#app").onclick = (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.filter) { filter = t.dataset.filter; store("hsk-progress-filter", filter); draw(); }
    if (t.dataset.drill) { try { exam = buildDrill(t.dataset.drill); save(); location.hash = "#/exam"; } catch (err) { $("#app").insertAdjacentHTML("afterbegin", `<div class="notice">${esc(err.message)}</div>`); } }
  };
  $("#app").onchange = null;
}

// ---------- speaking practice (levels with a "speaking" config; not scored) ----------
let SPEAK = null;
function speakStop() {
  if (!SPEAK) return;
  clearInterval(SPEAK.timer);
  if (SPEAK.rec && SPEAK.rec.state === "recording") { SPEAK.rec.onstop = null; SPEAK.rec.stop(); }
  stopAudio();
}
function speakCountdown(sec, label, onEnd) {
  clearInterval(SPEAK.timer);
  const end = Date.now() + sec * 1000;
  const draw = () => {
    const left = end - Date.now(), el = $("#spCount");
    if (el) el.textContent = `${label} ${fmtTime(left)}`;
    if (left <= 0) { clearInterval(SPEAK.timer); onEnd(); }
  };
  draw();
  SPEAK.timer = setInterval(draw, 250);
}
async function renderSpeaking(level) {
  $("#exambar").hidden = true;
  speakStop();
  await useLevel(level);
  const sp = CFG.speaking;
  if (!sp) { location.hash = `#/${CFG.level}`; return; }
  const used = recall("hsk-speak-used") || {};
  const tasks = sp.parts.flatMap((p) => byUsage(BANK[p.id] || [], used).slice(0, p.units).map((u) => ({ part: p, u })));
  SPEAK = { tasks, i: -1, stream: null, rec: null, timer: null };
  const row = (p) => `<tr><td>${esc(p.title)}</td><td>${esc(p.desc)}</td><td>${p.units} 题</td><td>${p.prepSeconds ? `准备 ${p.prepSeconds / 60} min · ` : ""}回答 ${p.answerSeconds >= 60 ? `${p.answerSeconds / 60} min` : `${p.answerSeconds} s`}</td></tr>`;
  $("#app").innerHTML = `<p><a href="#/${CFG.level}">← 返回 ${esc(CFG.short)}</a></p><h1>${esc(sp.name)} · ${esc(CFG.short)}</h1>
    <p class="muted">${esc(sp.note)}</p>
    <table class="hist"><tr><th>部分</th><th>题型</th><th>题数</th><th>时间</th></tr>${sp.parts.map(row).join("")}</table>
    <div class="notice" id="micNote">点击“开始”后浏览器会请求使用麦克风 · The browser will ask for your microphone. Without one you can still practise aloud with the timers.</div>
    <p><button class="btn primary" id="spStart">开始 · Start</button></p>`;
  $("#app").onclick = async (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.id === "spStart") {
      t.disabled = true;
      $("#micNote").textContent = "正在等待麦克风权限… · waiting for microphone permission (continues without recording after 20 s)";
      // An unanswered permission prompt never settles, so give up after 20 s and practise without recording.
      const wait = new Promise((resolve) => setTimeout(() => resolve(null), 20000));
      try { SPEAK.stream = await Promise.race([navigator.mediaDevices.getUserMedia({ audio: true }), wait]); } catch (err) { SPEAK.stream = null; }
      speakTask(0);
    } else if (t.id === "spNow") speakAnswer();
    else if (t.id === "spDone") speakFinish();
    else if (t.id === "spNext") speakTask(SPEAK.i + 1);
    else if (t.id === "spReplay") playOnce(audio(SPEAK.tasks[SPEAK.i].u.id));
  };
}
function speakTask(i) {
  speakStop();
  if (i >= SPEAK.tasks.length) return speakSummary();
  SPEAK.i = i;
  const { part, u } = SPEAK.tasks[i];
  const head = `<p class="muted">第 ${i + 1} / ${SPEAK.tasks.length} 题 · ${esc(part.title)} · ${esc(part.desc)}</p>`;
  const prompt = part.type === "picture_talk" ? `<div class="w2"><img src="${image(u.id)}" alt=""><div></div></div>`
    : part.type === "answer" ? `<div class="stmt">${esc(u.task)}</div>` : `<div class="small muted">听录音，然后重复你听到的话 · listen, then say it back</div>`;
  $("#app").innerHTML = `<h1>${esc(CFG.speaking.name)}</h1>${head}<div class="part spk">${prompt}
    <div class="spbar"><span id="spCount" class="timer"></span> <span id="spState" class="small muted"></span></div><div id="spCtl"></div></div>`;
  if (part.type === "repeat") {
    $("#spState").textContent = "正在播放 · playing (once)";
    player = new Audio(audio(u.id));
    player.onended = () => speakAnswer();
    player.onerror = () => speakAnswer();
    player.play().catch(() => speakAnswer());
  } else {
    if (part.type === "answer") playOnce(audio(u.id));
    $("#spState").textContent = "准备 · preparation";
    $("#spCtl").innerHTML = `<button class="btn small" id="spNow">开始回答 · Answer now</button>`;
    speakCountdown(part.prepSeconds, "准备", speakAnswer);
  }
}
function speakAnswer() {
  const { part } = SPEAK.tasks[SPEAK.i];
  stopAudio();
  SPEAK.chunks = [];
  SPEAK.rec = null;
  if (SPEAK.stream && window.MediaRecorder) {
    SPEAK.rec = new MediaRecorder(SPEAK.stream);
    SPEAK.rec.ondataavailable = (e) => e.data.size && SPEAK.chunks.push(e.data);
    SPEAK.rec.start();
  }
  $("#spState").innerHTML = SPEAK.rec ? `<span class="recdot"></span> 录音中 · recording` : "请开始说 · speak now (no microphone, not recorded)";
  $("#spCtl").innerHTML = `<button class="btn small primary" id="spDone">说完了 · Done</button>`;
  speakCountdown(part.answerSeconds, "回答", speakFinish);
}
function speakFinish() {
  clearInterval(SPEAK.timer);
  const t = SPEAK.tasks[SPEAK.i];
  const review = () => {
    const ref = t.part.type === "repeat" ? t.u.text : t.u.model;
    $("#spCount").textContent = "";
    $("#spState").textContent = "回顾 · review";
    $("#spCtl").innerHTML = `${t.url ? `<p><audio controls src="${t.url}"></audio></p>` : ""}
      ${t.part.type === "repeat" ? `<button class="playbtn" id="spReplay">▶ 再听一遍 replay</button>` : ""}
      <details ${t.part.type === "repeat" ? "open" : ""}><summary>${t.part.type === "repeat" ? "原文 what was said" : "参考答案 model answer"}</summary><div class="transcript">${esc(ref)}</div></details>
      <p><button class="btn primary" id="spNext">${SPEAK.i + 1 < SPEAK.tasks.length ? "下一题 · Next" : "结束 · Finish"}</button></p>`;
  };
  if (SPEAK.rec && SPEAK.rec.state === "recording") {
    SPEAK.rec.onstop = () => { t.url = URL.createObjectURL(new Blob(SPEAK.chunks, { type: SPEAK.rec.mimeType || "audio/webm" })); review(); };
    SPEAK.rec.stop();
  } else review();
}
function speakSummary() {
  speakStop();
  const used = recall("hsk-speak-used") || {};
  SPEAK.tasks.forEach((t) => (used[t.u.id] = (used[t.u.id] || 0) + 1));
  store("hsk-speak-used", used);
  if (SPEAK.stream) SPEAK.stream.getTracks().forEach((tr) => tr.stop());
  const label = (t) => t.part.type === "repeat" ? t.u.text : t.part.type === "answer" ? t.u.task : "看图说话 · picture";
  $("#app").innerHTML = `<p><a href="#/${CFG.level}">← 返回 ${esc(CFG.short)}</a></p><h1>口语练习完成 · Speaking done</h1>
    <p class="muted">Recordings stay in this browser tab only; download any you want to keep.</p>
    ${SPEAK.tasks.map((t, i) => `<div class="rv"><span class="qn">${i + 1}.</span><span class="stmt">${esc(label(t))}</span>
      ${t.url ? `<div><audio controls src="${t.url}"></audio> <a href="${t.url}" download="${CFG.level}-speaking-${i + 1}.webm">⬇ 下载</a></div>` : `<div class="small muted">no recording</div>`}
      <details><summary>${t.part.type === "repeat" ? "原文" : "参考答案 model answer"}</summary><div class="transcript">${esc(t.part.type === "repeat" ? t.u.text : t.u.model)}</div></details></div>`).join("")}
    <p><a class="btn" href="#/speaking/${CFG.level}">再练一次 · Again</a></p>`;
}

// ---------- router ----------
async function route() {
  clearInterval(tick);
  speakStop();
  window.scrollTo(0, 0);
  stopAudio();
  const h = location.hash;
  const [, page, arg] = h.split("/");
  if (page === "examday") await renderExamDay(arg || CFG?.level || "hsk4");
  else if (page === "progress") await renderProgress(arg || "hsk4");
  else if (page === "words") await renderWords(arg || "hsk4");
  else if (page === "sheet") await renderSheet(arg);
  else if (page === "speaking") await renderSpeaking(arg || "hsk4n");
  else if (h.startsWith("#/exam")) {
    exam = exam || recall("hsk-exam");
    if (!exam) { location.hash = "#/"; return; }
    if (exam.examDay && !exam.started) { location.hash = `#/examday/${exam.level}`; return; }
    await useLevel(exam.level || "hsk4");
    renderExam();
  } else if (h.startsWith("#/result/")) await renderResult(h.split("/")[2]);
  else await renderHome(h.split("/")[1] || null);
}

(async function init() {
  try { LEVELS = await api("/api/levels"); }
  catch (e) { $("#app").innerHTML = `<div class="notice">Start the server first: <code>.venv/bin/python server.py</code></div>`; return; }
  window.addEventListener("hashchange", route);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && exam && exam.examDay && exam.started && location.hash.startsWith("#/exam")) { exam.leftCount = (exam.leftCount || 0) + 1; save(); }
  });
  route();
})();
