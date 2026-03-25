console.log("app.js loaded (Decentralized Version)");

import { initializeApp as initializeFirebaseApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import {
  getDatabase,
  ref,
  onValue,
  set,
  update,
  onDisconnect,
  serverTimestamp,
  runTransaction
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";
import { GoogleGenerativeAI } from "https://unpkg.com/@google/generative-ai/dist/index.mjs";

const ROOM_PATH = "partyRoom";
const GAMEMODE_DURATION_SECONDS = { A: 20, B: 20, C: 30 };

const ANIMAL_META = {
  dog: { label: "小狗", emoji: "🐶" },
  bear: { label: "小熊", emoji: "🐻" },
  rabbit: { label: "小兔", emoji: "🐰" },
  fox: { label: "狐狸", emoji: "🦊" }
};

const SYSTEM_PROMPT = `Role: Fun party host. Target: Close friends (female/queer). Constraints: NO romance, men, sex, or gross topics. Output strictly valid JSON. Language: Simplified Chinese.`;

const localState = { status: "lobby", players: {}, gameState: {}, submissions: {} };
const myPlayerId = getOrCreateMyPlayerId();

function getOrCreateMyPlayerId() {
  try {
    const existing = sessionStorage.getItem("myPlayerId");
    if (existing && existing.trim()) return existing;
    const created = `p_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    sessionStorage.setItem("myPlayerId", created);
    return created;
  } catch (error) {
    console.error("错误位置: [生成 myPlayerId], 原因:", error);
    return `p_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

let db = null;
let geminiModel = null;

function getFirebaseConfig() {
  try {
    return window.APP_CONFIG && window.APP_CONFIG.firebase;
  } catch (error) {
    console.error("错误位置: [读取 Firebase config], 原因:", error);
    return null;
  }
}

function getGeminiApiKey() {
  try {
    const key = window.APP_CONFIG && window.APP_CONFIG.geminiApiKey;
    return typeof key === "string" && key.trim() ? key.trim() : null;
  } catch (error) {
    console.error("错误位置: [读取 Gemini API Key], 原因:", error);
    return null;
  }
}

function ensureGeminiModel() {
  try {
    if (geminiModel) return true;
    const apiKey = getGeminiApiKey();
    if (!apiKey) return false;
    const genAI = new GoogleGenerativeAI(apiKey);
    geminiModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash", systemInstruction: SYSTEM_PROMPT });
    return true;
  } catch (error) {
    console.error("错误位置: [初始化 Gemini Model], 原因:", error);
    return false;
  }
}

function parseJsonSafely(rawText) {
  try {
    const clean = String(rawText || "").replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (error) {
    console.error("错误位置: [解析 Gemini JSON], 原因:", error);
    return null;
  }
}

function nowMs() {
  return Date.now();
}

function msToSecondsCeil(ms) {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.ceil(ms / 1000));
}

function roomRootRef() { return ref(db, ROOM_PATH); }
function playersRef() { return ref(db, `${ROOM_PATH}/players`); }
function statusRef() { return ref(db, `${ROOM_PATH}/status`); }
function gameStateRef() { return ref(db, `${ROOM_PATH}/gameState`); }
function submissionsRef() { return ref(db, `${ROOM_PATH}/submissions`); }

function makeRoundId() {
  try {
    return `r_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  } catch (error) {
    return `r_${Date.now()}`;
  }
}

function pickRandom(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

function isPauseActive() {
  return !!localState.gameState?.pause?.active;
}

function getSubmissionsForRound() {
  const roundId = localState.gameState?.round?.id;
  if (!roundId) return {};
  return localState.submissions?.[roundId] || {};
}

async function initFirebase() {
  try {
    const firebaseConfig = getFirebaseConfig();
    if (!firebaseConfig) {
      console.error("错误位置: [Firebase 初始化], 原因:", new Error("缺少 APP_CONFIG.firebase"));
      return false;
    }
    const app = initializeFirebaseApp(firebaseConfig);
    db = getDatabase(app);
    return true;
  } catch (error) {
    console.error("错误位置: [Firebase 初始化], 原因:", error);
    return false;
  }
}

// ============================================================
// 分布式竞争锁
// ============================================================
async function claimActionLock(actionName, roundId) {
  try {
    const lockRef = ref(db, `${ROOM_PATH}/locks/${actionName}_${roundId}`);
    let success = false;
    await runTransaction(lockRef, (current) => {
      if (current === null) {
        success = true;
        return { lockedBy: myPlayerId, at: Date.now() };
      }
      return; 
    });
    return success;
  } catch (error) {
    return false;
  }
}

// ============================================================
// UI 与 视图控制
// ============================================================
const dom = {};
function bindDom() {
  dom.viewLobby = document.getElementById("view-lobby");
  dom.viewHall = document.getElementById("view-hall");
  dom.animalList = document.getElementById("animal-list");
  dom.joinBtn = document.getElementById("btn-join-party");
  dom.playerList = document.getElementById("player-list");
  dom.modeList = document.getElementById("mode-list");

  dom.modalConfirmStart = document.getElementById("modal-confirm-start");
  dom.btnConfirmStart = document.getElementById("btn-confirm-start");
  dom.btnCancelStart = document.getElementById("btn-cancel-start");
  dom.btnConfirmStartClose = document.getElementById("modal-confirm-start-close");

  dom.modalPaused = document.getElementById("modal-game-paused");
  dom.btnPauseContinue = document.getElementById("btn-pause-continue");
  dom.btnPauseReturnHall = document.getElementById("btn-pause-return-hall");
  dom.btnPauseClose = document.getElementById("modal-game-paused-close");

  dom.modalModeA = document.getElementById("modal-mode-a");
  dom.modalModeB = document.getElementById("modal-mode-b");
  dom.modalModeC = document.getElementById("modal-mode-c");

  dom.modeAAbort = document.getElementById("modal-mode-a-abort");
  dom.modeAQuestion = document.getElementById("modal-mode-a-question");
  dom.modeAWaiting = document.getElementById("modal-mode-a-waiting");
  dom.modeAResults = document.getElementById("modal-mode-a-results");
  dom.modeAResultsList = document.getElementById("modal-mode-a-results-list");
  dom.modeAOptions = document.getElementById("modal-mode-a-options");
  dom.modeADecode = document.getElementById("modal-mode-a-decode");
  dom.modeACountdown = document.getElementById("modal-mode-a-countdown");
  dom.modeACountdownLabel = document.getElementById("modal-mode-a-countdown-label");

  dom.modeBAbort = document.getElementById("modal-mode-b-abort");
  dom.modeBQuestion = document.getElementById("modal-mode-b-question");
  dom.modeBWaiting = document.getElementById("modal-mode-b-waiting");
  dom.modeBResults = document.getElementById("modal-mode-b-results");
  dom.modeBResultsList = document.getElementById("modal-mode-b-results-list");
  dom.modeBOptions = document.getElementById("modal-mode-b-options");
  dom.modeBCountdown = document.getElementById("modal-mode-b-countdown");
  dom.modeBCountdownLabel = document.getElementById("modal-mode-b-countdown-label");

  dom.modeCAbort = document.getElementById("modal-mode-c-abort");
  dom.modeCMission = document.getElementById("modal-mode-c-mission");
  dom.modeCWaiting = document.getElementById("modal-mode-c-waiting");
  dom.modeCResults = document.getElementById("modal-mode-c-results");
  dom.modeCResultsList = document.getElementById("modal-mode-c-results-list");
  dom.modeCOptions = document.getElementById("modal-mode-c-options");
  dom.modeCCountdown = document.getElementById("modal-mode-c-countdown");
  dom.modeCCountdownLabel = document.getElementById("modal-mode-c-countdown-label");
}

function openModal(el) { if (el) el.classList.add("is-open"); }
function closeModal(el) { if (el) el.classList.remove("is-open"); }
function hideAllGameModals() { closeModal(dom.modalModeA); closeModal(dom.modalModeB); closeModal(dom.modalModeC); }

function setViews({ lobbyVisible, hallVisible }) {
  if (dom.viewLobby) dom.viewLobby.style.display = lobbyVisible ? "" : "none";
  if (dom.viewHall) dom.viewHall.style.display = hallVisible ? "" : "none";
}

let currentSelectedAnimalKey = null;
let pendingStartMode = null;
let lastRenderedRoundKey = "";

function refreshLobbyUI() {
  const disabled = !currentSelectedAnimalKey;
  if (!dom.joinBtn) return;
  dom.joinBtn.disabled = disabled;
  dom.joinBtn.style.opacity = disabled ? "0.7" : "1";
}

function refreshViewForJoinState() {
  const isIn = !!localState.players?.[myPlayerId];
  setViews({ lobbyVisible: !isIn, hallVisible: isIn });
}

function renderHallPlayers() {
  if (!dom.playerList) return;
  const players = Object.entries(localState.players || {})
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
  dom.playerList.innerHTML = players
    .map((p) => {
      const meta = ANIMAL_META[p.animalKey] || { label: p.id, emoji: "❓" };
      const selected = p.id === myPlayerId ? "animal-card-selected" : "";
      return `
          <div class="animal-card ${selected}" style="pointer-events:none; cursor:default;">
            <div class="animal-icon"><span class="animal-emoji">${meta.emoji}</span></div>
            <div class="animal-name">${meta.label}</div>
          </div>
        `;
    })
    .join("");
}

function refreshModeButtons() {
  if (!dom.modeList) return;
  const count = Object.keys(localState.players || {}).length;
  dom.modeList.querySelectorAll(".mode-btn").forEach((btn) => {
    const required = btn.dataset.mode === "A" ? 1 : 2;
    btn.disabled = count < required;
    btn.style.opacity = btn.disabled ? "0.65" : "1";
  });
}

function openOverlayForRound(round) {
  hideAllGameModals();
  closeModal(dom.modalPaused);
  if (isPauseActive()) return openModal(dom.modalPaused);
  if (round?.subMode === "A") openModal(dom.modalModeA);
  if (round?.subMode === "B") openModal(dom.modalModeB);
  if (round?.subMode === "C") openModal(dom.modalModeC);
}

function ensureRoundRendered(round) {
  if (!round) return;
  const key = `${round.id || "?"}_${round.stage || "?"}`;
  if (key === lastRenderedRoundKey) return;
  lastRenderedRoundKey = key;
  openOverlayForRound(round);
  renderRoundContent(round);
}

function renderCountdown(round) {
  if (!round || isPauseActive()) return;
  const stage = round.stage;
  const msLeft = (stage.endsWith("_revealed") ? round.autoNextAt : round.endsAt) - nowMs();
  const label = stage.endsWith("_revealed") ? "秒后自动下一题" : "秒后自动结束";
  
  const targetLabel = dom[`mode${round.subMode}CountdownLabel`];
  const targetCounter = dom[`mode${round.subMode}Countdown`];
  if (targetLabel) targetLabel.textContent = label;
  if (targetCounter) targetCounter.textContent = String(msToSecondsCeil(msLeft));
}

function renderRoundContent(round) {
  if (round.subMode === "A") return renderModeA(round);
  if (round.subMode === "B") return renderModeB(round);
  if (round.subMode === "C") return renderModeC(round);
}

// ============================================================
// 模式渲染逻辑 (Mode A/B/C)
// ============================================================
function renderModeA(round) {
  const stage = round.stage;
  const subs = getSubmissionsForRound();
  const canAnswer = stage === "a_answer" && (round.participantIds || []).includes(myPlayerId) && !subs[myPlayerId];

  dom.modeAResults.style.display = "none";
  dom.modeAWaiting.style.display = "none";
  dom.modeAOptions.style.display = "none";
  dom.modeADecode.textContent = round.decode || "";
  dom.modeAQuestion.textContent = round.question || "正在生成题目...";

  if (stage === "init") {
    dom.modeAWaiting.style.display = "block";
    dom.modeAWaiting.textContent = "正在生成题目...";
  } else if (stage === "a_answer") {
    dom.modeAOptions.style.display = canAnswer ? "flex" : "none";
    dom.modeAWaiting.style.display = canAnswer ? "none" : "block";
    dom.modeAWaiting.textContent = subs[myPlayerId] ? "你已提交，等待揭晓..." : "正在作答...";
    renderModeAOptions(round.options);
  } else if (stage === "a_revealed") {
    dom.modeAQuestion.textContent = "结果揭晓：";
    dom.modeAResults.style.display = "block";
    renderModeAResults(round);
  }
}

function renderModeAOptions(options) {
  dom.modeAOptions.querySelectorAll(".modal-option").forEach(btn => {
    btn.querySelector(".modal-option-text").textContent = options?.[btn.dataset.option] || "";
  });
}

function renderModeAResults(round) {
  const results = round.results || {};
  dom.modeAResultsList.innerHTML = (round.participantIds || []).map(pid => {
    const meta = ANIMAL_META[localState.players[pid]?.animalKey] || { label: pid, emoji: "❓" };
    const r = results[pid] || {};
    return `<div class="modal-results-item">
      <span>${meta.emoji} ${meta.label}</span>
      <span>${!r.optionKey ? "未作答" : (r.isCorrect ? "✅ 正确" : "❌ 错误") + " (选" + r.optionKey + ")"}</span>
    </div>`;
  }).join("");
}

function renderModeB(round) {
  const stage = round.stage;
  const subs = getSubmissionsForRound();
  dom.modeBResults.style.display = "none";
  dom.modeBWaiting.style.display = "none";
  dom.modeBOptions.style.display = "none";

  if (stage === "init") {
    dom.modeBWaiting.style.display = "block";
    dom.modeBWaiting.textContent = "正在准备吐槽...";
  } else if (stage === "b_target_choice") {
    dom.modeBQuestion.textContent = round.question || "";
    const isTarget = myPlayerId === round.targetPlayerId;
    dom.modeBOptions.style.display = isTarget ? "flex" : "none";
    dom.modeBWaiting.style.display = isTarget ? "none" : "block";
    dom.modeBWaiting.textContent = "Target 正在选择真心话/谎话...";
  } else if (stage === "b_vote") {
    dom.modeBQuestion.textContent = "猜测：Target 选了真心话还是谎话？";
    const canVote = myPlayerId !== round.targetPlayerId && !subs[myPlayerId];
    dom.modeBOptions.style.display = canVote ? "flex" : "none";
    dom.modeBWaiting.style.display = canVote ? "none" : "block";
    dom.modeBWaiting.textContent = subs[myPlayerId] ? "你已投票，等待揭晓..." : "Target 正在揭晓中...";
  } else if (stage === "b_revealed") {
    dom.modeBQuestion.textContent = "雷达揭晓：";
    dom.modeBResults.style.display = "block";
    renderModeBResults(round);
  }
}

function renderModeBResults(round) {
  const res = round.results || {};
  const targetMeta = ANIMAL_META[localState.players[res.targetPlayerId]?.animalKey] || { label: "Target", emoji: "❓" };
  dom.modeBResultsList.innerHTML = `<div class="modal-results-item"><b>${targetMeta.emoji} ${targetMeta.label}: ${res.targetChoice === "truth" ? "真心话" : "谎话"}</b></div>` + 
    (round.participantIds || []).filter(pid => pid !== res.targetPlayerId).map(pid => {
      const meta = ANIMAL_META[localState.players[pid]?.animalKey] || { label: pid, emoji: "❓" };
      const v = res.votes?.[pid];
      return `<div class="modal-results-item"><span>${meta.emoji} ${meta.label}</span><span>${!v ? "未投票" : (v.isCorrect ? "猜对了" : "猜错了")}</span></div>`;
    }).join("");
}

function renderModeC(round) {
  const stage = round.stage;
  const subs = getSubmissionsForRound();
  dom.modeCResults.style.display = "none";
  dom.modeCWaiting.style.display = "none";
  dom.modeCOptions.style.display = "none";

  if (stage === "c_mission") {
    dom.modeCMission.textContent = round.mission || "";
    const isTarget = myPlayerId === round.targetPlayerId;
    dom.modeCOptions.style.display = isTarget ? "flex" : "none";
    dom.modeCWaiting.style.display = isTarget ? "none" : "block";
    dom.modeCWaiting.textContent = subs[myPlayerId] ? "已完成任务，等待结算..." : "等待 Target 完成任务...";
  } else if (stage === "c_revealed") {
    dom.modeCMission.textContent = "任务回顾：";
    dom.modeCResults.style.display = "block";
    renderModeCResults(round);
  }
}

function renderModeCResults(round) {
  const res = round.results || {};
  const targetMeta = ANIMAL_META[localState.players[res.targetPlayerId]?.animalKey] || { label: "Target", emoji: "❓" };
  dom.modeCResultsList.innerHTML = `<div class="modal-results-item">任务：${round.mission}</div>` + 
    `<div class="modal-results-item">${targetMeta.emoji} ${targetMeta.label}: ${res.doneByTarget ? "✅ 已完成" : "❌ 未完成"}</div>`;
}

// ============================================================
// 分布式逻辑推进 (不再有 hostId)
// ============================================================
async function gameLoopTick() {
  if (!db || localState.status !== "playing" || isPauseActive()) return;
  const round = localState.gameState?.round;
  if (!round) return;

  // 1. 生成题目
  if (round.stage === "init") {
    if (await claimActionLock("gen", round.id)) await hostGenerateQuestionForRound(round);
    return;
  }
  // 2. 自动揭晓
  if (shouldRevealByTime(round)) {
    if (await claimActionLock("reveal", round.id + "_" + round.stage)) await hostRevealRound(round, getSubmissionsForRound());
    return;
  }
  // 3. 自动下一题
  if (isAutoNextDue(round)) {
    if (await claimActionLock("next", round.id)) await hostGenerateNextRoundAndQuestion(round);
    return;
  }
}

async function requestStartParty(selectedMode) {
  if (!selectedMode || !db) return;
  try {
    const participantIds = Object.keys(localState.players || {});
    if (!participantIds.length) return;

    await set(ref(db, `${ROOM_PATH}/locks`), null); // 物理清理所有锁
    await set(ref(db, `${ROOM_PATH}/submissions`), null);

    await update(roomRootRef(), {
      status: "playing",
      gameState: {
        mode: selectedMode,
        pause: { active: false },
        round: {
          id: makeRoundId(),
          subMode: selectedMode === "D" ? pickRandom(["A", "B", "C"]) : selectedMode,
          stage: "init",
          participantIds: participantIds
        }
      }
    });
  } catch (error) { console.error("开启游戏失败:", error); }
}

async function requestPause() {
  if (!db) return;
  try {
    const round = localState.gameState.round || {};
    await update(roomRootRef(), {
      "gameState.pause": {
        active: true,
        appliedAtMs: Date.now(),
        snapshot: { endsAt: round.endsAt || null, autoNextAt: round.autoNextAt || null }
      }
    });
  } catch (error) { console.error("暂停失败:", error); }
}

async function requestContinue() {
  if (!db) return;
  try {
    const pause = localState.gameState.pause;
    const delta = Date.now() - (pause.appliedAtMs || Date.now());
    const patch = { "gameState.pause.active": false };
    if (pause.snapshot?.endsAt) patch["gameState.round.endsAt"] = pause.snapshot.endsAt + delta;
    if (pause.snapshot?.autoNextAt) patch["gameState.round.autoNextAt"] = pause.snapshot.autoNextAt + delta;
    await update(roomRootRef(), patch);
  } catch (error) { console.error("继续失败:", error); }
}

async function requestReturnHall() {
  if (!db) return;
  await update(roomRootRef(), { status: "hall", "gameState.mode": null, "gameState.round": null, "gameState.pause.active": false });
}

// ============================================================
// 提交与生成 (保持原有功能，去掉 claimGenerationLock 旧锁)
// ============================================================
async function submitModeA(optionKey) {
  const round = localState.gameState?.round;
  if (round?.stage !== "a_answer" || isPauseActive()) return;
  await update(ref(db, `${ROOM_PATH}/submissions/${round.id}/${myPlayerId}`), { optionKey, submittedAt: serverTimestamp() });
}

async function submitModeB(val) {
  const round = localState.gameState?.round;
  if (!round || isPauseActive()) return;
  const path = `${ROOM_PATH}/submissions/${round.id}/${myPlayerId}`;
  if (round.stage === "b_target_choice" && myPlayerId === round.targetPlayerId) await update(ref(db, path), { choice: val, submittedAt: serverTimestamp() });
  if (round.stage === "b_vote" && myPlayerId !== round.targetPlayerId) await update(ref(db, path), { guess: val, submittedAt: serverTimestamp() });
}

async function submitModeC_done() {
  const round = localState.gameState?.round;
  if (round?.stage !== "c_mission" || isPauseActive() || myPlayerId !== round.targetPlayerId) return;
  await update(ref(db, `${ROOM_PATH}/submissions/${round.id}/${myPlayerId}`), { done: true, submittedAt: serverTimestamp() });
}

async function hostGenerateQuestionForRound(round) {
  const ids = round.participantIds || Object.keys(localState.players);
  if (round.subMode === "A") return generateModeAQuestion(round.id, ids);
  if (round.subMode === "B") return generateModeBQuestion(round.id, ids);
  if (round.subMode === "C") return generateModeCQuestion(round.id, ids);
}

async function hostRevealRound(round, subs) {
  const subMode = round.subMode;
  const revAt = nowMs();
  if (subMode === "A") {
    const results = {};
    round.participantIds.forEach(pid => {
      const s = subs[pid] || {};
      results[pid] = { optionKey: s.optionKey || null, isCorrect: s.optionKey === round.correct };
    });
    await update(roomRootRef(), { "gameState.round": { ...round, stage: "a_revealed", results, revealedAt: revAt, autoNextAt: revAt + 10000 } });
  } else if (subMode === "B" && round.stage === "b_target_choice") {
    const choice = subs[round.targetPlayerId]?.choice || pickRandom(["truth", "lie"]);
    await update(roomRootRef(), { "gameState.round": { ...round, stage: "b_vote", targetChoice: choice, endsAt: revAt + 20000 } });
  } else if (subMode === "B" && round.stage === "b_vote") {
    const votes = {};
    round.participantIds.forEach(pid => {
      if (pid === round.targetPlayerId) return;
      const s = subs[pid] || {};
      votes[pid] = { guess: s.guess || null, isCorrect: s.guess === round.targetChoice };
    });
    await update(roomRootRef(), { "gameState.round": { ...round, stage: "b_revealed", results: { targetPlayerId: round.targetPlayerId, targetChoice: round.targetChoice, votes }, revealedAt: revAt, autoNextAt: revAt + 10000 } });
  } else if (subMode === "C") {
    await update(roomRootRef(), { "gameState.round": { ...round, stage: "c_revealed", results: { targetPlayerId: round.targetPlayerId, doneByTarget: !!subs[round.targetPlayerId]?.done }, revealedAt: revAt, autoNextAt: revAt + 10000 } });
  }
}

async function hostGenerateNextRoundAndQuestion(round) {
  const mode = localState.gameState.mode;
  await set(ref(db, `${ROOM_PATH}/submissions`), null);
  await set(ref(db, `${ROOM_PATH}/locks`), null);
  await update(roomRootRef(), {
    "gameState.round": {
      id: makeRoundId(),
      subMode: mode === "D" ? pickRandom(["A", "B", "C"]) : mode,
      stage: "init",
      participantIds: round.participantIds
    }
  });
}

// ============================================================
// Gemini 生成函数
// ============================================================
async function generateModeAQuestion(roundId, ids) {
  let payload = { question: "（备用）世界上最大的沙漠是？", options: { A: "撒哈拉", B: "南极洲", C: "戈壁", D: "塔克拉玛干" }, correct: "B", decode: "南极洲降水极少，符合沙漠定义。" };
  if (ensureGeminiModel()) {
    try {
      const res = await geminiModel.generateContent(`为 Mode A 生成百科小知识 JSON: {"question":"...","options":{"A":"...","B":"...","C":"...","D":"..."},"correct":"A|B|C|D","decode":"..."}`);
      const parsed = parseJsonSafely(res?.response?.text());
      if (parsed) payload = parsed;
    } catch (e) { console.error(e); }
  }
  const start = nowMs();
  await update(roomRootRef(), { "gameState.round": { ...payload, id: roundId, subMode: "A", stage: "a_answer", participantIds: ids, startedAt: start, endsAt: start + 20000 } });
}

async function generateModeBQuestion(roundId, ids) {
  let q = "（备用）你最不能忍受的一种食物搭配是什么？";
  const target = pickRandom(ids);
  if (ensureGeminiModel()) {
    try {
      const res = await geminiModel.generateContent(`为 Mode B 生成一个针对 Target 的日常吐槽问题 JSON: {"question":"..."}`);
      q = parseJsonSafely(res?.response?.text())?.question || q;
    } catch (e) { console.error(e); }
  }
  const start = nowMs();
  await update(roomRootRef(), { "gameState.round": { id: roundId, subMode: "B", stage: "b_target_choice", participantIds: ids, targetPlayerId: target, question: q, startedAt: start, endsAt: start + 20000 } });
}

async function generateModeCQuestion(roundId, ids) {
  let m = "（备用）用一张纸巾给自己做一个简易领结并展示 5 秒。";
  const target = pickRandom(ids);
  if (ensureGeminiModel()) {
    try {
      const res = await geminiModel.generateContent(`为 Mode C 生成一个卧室搞笑任务 JSON: {"mission":"..."}`);
      m = parseJsonSafely(res?.response?.text())?.mission || m;
    } catch (e) { console.error(e); }
  }
  const start = nowMs();
  await update(roomRootRef(), { "gameState.round": { id: roundId, subMode: "C", stage: "c_mission", participantIds: ids, targetPlayerId: target, mission: m, startedAt: start, endsAt: start + 30000 } });
}

// ============================================================
// 主启动
// ============================================================
async function main() {
  bindDom();
  bindDomEvents();
  refreshLobbyUI();
  if (await initFirebase()) {
    attachFirebaseListeners();
    setInterval(() => tickUI(), 250);
    setInterval(() => gameLoopTick().catch(e => console.error(e)), 1000);
  }
}

document.addEventListener("DOMContentLoaded", main);
