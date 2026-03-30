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

// 🌟 新增：从独立文件引入三大题库
import { 
  MODE_A_FALLBACK_POOL, 
  MODE_B_FALLBACK_POOL, 
  MODE_C_FALLBACK_POOL 
} from "./questions.js";

console.log("app.js loaded");

let currentSelectedAnimalKey = null;
let pendingStartMode = null;
let lastRenderedRoundKey = "";
let db = null;
let geminiModel = null;
let serverTimeOffset = 0;

const ROOM_PATH = "partyRoom";
const GAMEMODE_DURATION_SECONDS = { A: 15, B: 15, C: 30 };
// 修改 localState，加入 globalHistory 容器
const localState = { 
  status: "lobby", 
  players: {}, 
  gameState: {}, 
  submissions: {},
  globalHistory: {} 
};

const ANIMAL_META = {
  dog: { label: "小狗", emoji: "🐶" },
  bear: { label: "小熊", emoji: "🐻" },
  rabbit: { label: "小兔", emoji: "🐰" },
  fox: { label: "狐狸", emoji: "🦊" }
};

// ============================================================
// 题库抽取与生成逻辑：Mode A (百科冷知识)
// ============================================================

function getNextFallbackQuestionA() {
  // 从全局独立节点读取历史
  const usedIndices = localState.globalHistory?.usedModeAIndices || [];
  let availableIndices = [];

  for (let i = 0; i < MODE_A_FALLBACK_POOL.length; i++) {
    if (!usedIndices.includes(i)) availableIndices.push(i);
  }

  if (availableIndices.length === 0) {
    availableIndices = MODE_A_FALLBACK_POOL.map((_, i) => i);
  }

  const pickedIndex = pickRandom(availableIndices);
  const newUsedIndices = availableIndices.length === MODE_A_FALLBACK_POOL.length
    ? [pickedIndex]
    : [...usedIndices, pickedIndex];

  return {
    fallbackData: MODE_A_FALLBACK_POOL[pickedIndex],
    newUsedIndices: newUsedIndices
  };
}

async function applyModeAFallback(roundId, participantIds) {
  try {
    const { fallbackData, newUsedIndices } = getNextFallbackQuestionA();
    const startedAt = nowMs();
    const endsAt = startedAt + (GAMEMODE_DURATION_SECONDS.A || 15) * 1000;

    // 构建多路径更新包
    const multiPathUpdates = {};
    
    // 路径一：更新全局历史（绝对路径）
    multiPathUpdates[`${GLOBAL_HISTORY_PATH}/usedModeAIndices`] = newUsedIndices;
    
    // 路径二：更新房间内的游戏状态（绝对路径）
    multiPathUpdates[`${ROOM_PATH}/gameState/round`] = {
      ...localState.gameState?.round,
      id: roundId,
      subMode: "A",
      stage: "a_answer",
      participantIds,
      question: fallbackData.question,
      options: fallbackData.options,
      correct: fallbackData.correct,
      decode: fallbackData.decode,
      startedAt,
      endsAt,
      autoNextAt: null,
      revealedAt: null,
      results: null
    };

    // 核心改变：向数据库根节点 ref(db) 提交原子更新
    await update(ref(db), multiPathUpdates);

  } catch (error) {
    console.error("错误位置: [applyModeAFallback], 原因:", error);
  }
}

async function generateModeAQuestion(roundId, participantIds) {
  // 插入无条件短路语句，直接强制执行本地题库逻辑，彻底阻断下方的 AI 调度
  return applyModeAFallback(roundId, participantIds);

  // 以下原有的代码虽然存在，但由于控制流已被截断，它们在物理层面上已成为死代码（Dead Code），永远不会被执行
  if (!ensureGeminiModel()) return applyModeAFallback(roundId, participantIds);
  try {
    const { fallbackData, newUsedIndices } = getNextFallbackQuestionA();

    const prompt = `为 Mode A 生成“百科小冷知识选择题”（冷门有趣、跨越多学科、适合青少年及以上）。
只输出严格有效 JSON，格式为：{"question":"...","options":{"A":"...","B":"...","C":"...","D":"..."},"correct":"A|B|C|D","decode":"..."}。
Language: 简体中文；不要提及与节目/剧情相关内容。
核心约束：
- correct 字段的值必须是 options 中实际存在的键。
- decode 字段必须是对 correct 选项的严谨、客观的解释，逻辑必须保持高度一致。`;

    const result = await geminiModel.generateContent(prompt);
    const rawText = result?.response ? result.response.text() : "";
    const parsed = parseJsonSafely(rawText);

    const isAIValid = parsed?.question && parsed?.options && parsed?.correct;
    const payload = isAIValid ? parsed : fallbackData;

    const startedAt = nowMs();
    const endsAt = startedAt + (GAMEMODE_DURATION_SECONDS.A || 15) * 1000;

    const patchData = {
      "gameState/round": {
        ...localState.gameState?.round,
        id: roundId,
        subMode: "A",
        stage: "a_answer",
        participantIds,
        question: payload.question,
        options: payload.options,
        correct: payload.correct,
        decode: payload.decode,
        startedAt,
        endsAt,
        autoNextAt: null,
        revealedAt: null,
        results: null
      }
    };

    if (!isAIValid) {
      patchData["gameState/usedModeAIndices"] = newUsedIndices;
    }

    await update(roomRootRef(), patchData);
  } catch (error) {
    console.error("错误位置: [generateModeAQuestion], 原因:", error);
    await applyModeAFallback(roundId, participantIds);
  }
}

// ============================================================
// 题库抽取与生成逻辑：Mode B (真心话雷达)
// ============================================================

function getNextFallbackQuestionB() {
  const usedIndices = localState.gameState?.usedModeBIndices || [];
  let availableIndices = [];

  for (let i = 0; i < MODE_B_FALLBACK_POOL.length; i++) {
    if (!usedIndices.includes(i)) availableIndices.push(i);
  }

  // 兜底机制：如果所有题目都被使用过，则清空记忆，重新开启新一轮循环
  if (availableIndices.length === 0) {
    availableIndices = MODE_B_FALLBACK_POOL.map((_, i) => i);
  }

  const pickedIndex = pickRandom(availableIndices);
  
  const newUsedIndices = availableIndices.length === MODE_B_FALLBACK_POOL.length
    ? [pickedIndex]
    : [...usedIndices, pickedIndex];

  return {
    fallbackData: MODE_B_FALLBACK_POOL[pickedIndex],
    newUsedIndices: newUsedIndices
  };
}

// （此处应当承接完整的 applyModeBFallback 和 generateModeBQuestion 函数）


// ============================================================
// 题库抽取与生成逻辑：Mode C (卧室大冒险)
// ============================================================

function getNextFallbackMissionC() {
  const usedIndices = localState.gameState?.usedModeCIndices || [];
  let availableIndices = [];

  for (let i = 0; i < MODE_C_FALLBACK_POOL.length; i++) {
    if (!usedIndices.includes(i)) availableIndices.push(i);
  }

  // 如果所有题目都出过了，则清空记忆，重新开始新一轮循环
  if (availableIndices.length === 0) {
    availableIndices = MODE_C_FALLBACK_POOL.map((_, i) => i);
  }

  const pickedIndex = pickRandom(availableIndices);
  
  const newUsedIndices = availableIndices.length === MODE_C_FALLBACK_POOL.length
    ? [pickedIndex]
    : [...usedIndices, pickedIndex];

  return {
    fallbackData: MODE_C_FALLBACK_POOL[pickedIndex],
    newUsedIndices: newUsedIndices
  };
}

// （此处应当承接完整的 applyModeCFallback 和 generateModeCQuestion 函数）

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
    // 优先从本地存储读取
    let key = localStorage.getItem("my_gemini_api_key");
    
    // 如果没有存储过，或者 Key 是无效的占位符
    if (!key || key.length < 10) {
      key = window.prompt("为了 GitHub 部署安全，请粘贴你的 Gemini API Key：\n(该 Key 仅保存在你的浏览器本地，不会上传到代码库)");
      if (key) {
        localStorage.setItem("my_gemini_api_key", key.trim());
      }
    }
    return key && key.trim() ? key.trim() : null;
  } catch (error) {
    console.error("读取本地存储 Key 失败:", error);
    return null;
  }
}

function ensureGeminiModel() {
  try {
    if (geminiModel) return true;
    const apiKey = getGeminiApiKey();
    if (!apiKey) return false;
    const genAI = new GoogleGenerativeAI(apiKey);
    geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash", systemInstruction: SYSTEM_PROMPT });
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
  // 核心修复：本地时间 + 服务器误差 = 绝对标准的云端时间
  return Date.now() + serverTimeOffset;
}

function msToSecondsCeil(ms) {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.ceil(ms / 1000));
}

function roomRootRef() {
  return ref(db, ROOM_PATH);
}
function playersRef() {
  return ref(db, `${ROOM_PATH}/players`);
}
function statusRef() {
  return ref(db, `${ROOM_PATH}/status`);
}
function gameStateRef() {
  return ref(db, `${ROOM_PATH}/gameState`);
}
function submissionsRef() {
  return ref(db, `${ROOM_PATH}/submissions`);
}
function generationLockRef() {
  return ref(db, `${ROOM_PATH}/gameState/generationLock`);
}
function startLockRef() {
  return ref(db, `${ROOM_PATH}/gameState/startLock`);
}

function makeRoundId() {
  try {
    return `r_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  } catch (error) {
    console.error("错误位置: [生成 roundId], 原因:", error);
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


const dom = {};
function bindDom() {
  dom.viewLobby = document.getElementById("view-lobby");
  dom.viewHall = document.getElementById("view-hall");
  dom.animalList = document.getElementById("animal-list");
  dom.joinBtn = document.getElementById("btn-join-party");
  dom.playerList = document.getElementById("player-list");
  dom.modeList = document.getElementById("mode-list");
  // 1. 新增：网络连接文字容器
  dom.lobbyLoadingStatus = document.getElementById("lobby-loading-status");
  // 2. 新增：Unavailable（已占用）弹窗相关组件
  dom.modalAnimalTaken = document.getElementById("modal-animal-taken");
  dom.btnAnimalTakenOk = document.getElementById("btn-animal-taken-ok");
  dom.modalAnimalTakenClose = document.getElementById("modal-animal-taken-close");

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

  dom.modeBQuestion = document.getElementById("modal-mode-b-question");
  dom.modeBWaiting = document.getElementById("modal-mode-b-waiting");
  dom.modeBOptions = document.getElementById("modal-mode-b-options");
  dom.modeBSpeakBox = document.getElementById("modal-mode-b-speak-box");
  dom.modeBResults = document.getElementById("modal-mode-b-results");
  dom.modeBResultsList = document.getElementById("modal-mode-b-results-list");
  dom.modeBAbort = document.getElementById("modal-mode-b-abort");
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

  dom.modeAFinalBoard = document.getElementById("mode-a-final-board");
  dom.finalFeedbackIcon = document.getElementById("final-feedback-icon");
  dom.finalFeedbackText = document.getElementById("final-feedback-text");
  dom.finalLeaderboardList = document.getElementById("final-leaderboard-list");
  dom.btnFinalNextRound = document.getElementById("btn-final-next-round");
  dom.btnFinalReturnHall = document.getElementById("btn-final-return-hall");
}

function openModal(el) {
  try {
    if (!el) return;
    el.classList.add("is-open");
    el.setAttribute("aria-hidden", "false");
  } catch (error) {
    console.error("错误位置: [openModal], 原因:", error);
  }
}
function closeModal(el) {
  try {
    if (!el) return;
    el.classList.remove("is-open");
    el.setAttribute("aria-hidden", "true");
  } catch (error) {
    console.error("错误位置: [closeModal], 原因:", error);
  }
}
function hideAllGameModals() {
  closeModal(dom.modalModeA);
  closeModal(dom.modalModeB);
  closeModal(dom.modalModeC);
}

function setViews({ lobbyVisible, hallVisible }) {
  try {
    if (dom.viewLobby) dom.viewLobby.style.display = lobbyVisible ? "" : "none";
    if (dom.viewHall) dom.viewHall.style.display = hallVisible ? "" : "none";
  } catch (error) {
    console.error("错误位置: [setViews], 原因:", error);
  }
}

function refreshLobbyUI() {
  try {
    const disabled = !currentSelectedAnimalKey;
    if (!dom.joinBtn) return;
    dom.joinBtn.disabled = disabled;
    dom.joinBtn.style.opacity = disabled ? "0.7" : "1";
    dom.joinBtn.style.cursor = disabled ? "not-allowed" : "pointer";
  } catch (error) {
    console.error("错误位置: [refreshLobbyUI], 原因:", error);
  }
}

function refreshAnimalSelectionUI() {
  try {
    if (!dom.animalList) return;

    const takenAnimals = [];
    
    // 🌟 监控探头 1：看看我是谁，以及系统目前拿到的数据库长什么样
    console.log("【排查去重】当前我的ID:", myPlayerId);
    console.log("【排查去重】当前数据库里的所有玩家:", JSON.parse(JSON.stringify(localState.players || {})));

    Object.entries(localState.players || {}).forEach(([playerId, pData]) => {
      // 如果不是我自己，且他选了动物，就加进黑名单
      if (playerId !== myPlayerId && pData.animalKey) {
        takenAnimals.push(pData.animalKey);
      }
    });

    // 🌟 监控探头 2：看看系统最终计算出来的黑名单对不对
    console.log("【排查去重】最终被别人占用的动物:", takenAnimals);

    dom.animalList.querySelectorAll(".animal-card").forEach((card) => {
      const animalKey = card.dataset.animal;
      const isTaken = takenAnimals.includes(animalKey);

      if (isTaken) {
        card.style.opacity = "0.3";
        card.style.filter = "grayscale(100%)";
        card.dataset.disabled = "true"; 
      } else {
        card.style.opacity = "1";
        card.style.filter = "none";
        card.dataset.disabled = "false"; 
      }
    });
  } catch (error) {
    console.error("错误位置: [refreshAnimalSelectionUI], 原因:", error);
  }
}

function refreshViewForJoinState() {
  try {
    const isIn = !!localState.players?.[myPlayerId];
    setViews({ lobbyVisible: !isIn, hallVisible: isIn });
  } catch (error) {
    console.error("错误位置: [refreshViewForJoinState], 原因:", error);
  }
}

function renderHallPlayers() {
  try {
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
            <div class="animal-icon" aria-hidden="true"><span class="animal-emoji" aria-hidden="true">${meta.emoji}</span></div>
            <div class="animal-name">${meta.label}</div>
          </div>
        `;
      })
      .join("");
  } catch (error) {
    console.error("错误位置: [renderHallPlayers], 原因:", error);
  }
}

function refreshModeButtons() {
  try {
    if (!dom.modeList) return;
    const count = Object.keys(localState.players || {}).length;
    dom.modeList.querySelectorAll(".mode-btn").forEach((btn) => {
      const mode = btn.dataset.mode;
      const required = mode === "A" ? 1 : 2;
      const disabled = count < required;
      btn.disabled = disabled;
      btn.style.opacity = disabled ? "0.65" : "1";
      btn.style.cursor = disabled ? "not-allowed" : "pointer";
      btn.style.pointerEvents = disabled ? "none" : "auto";
    });
  } catch (error) {
    console.error("错误位置: [refreshModeButtons], 原因:", error);
  }
}

function openOverlayForRound(round) {
  hideAllGameModals();
  closeModal(dom.modalPaused);
  if (isPauseActive()) return openModal(dom.modalPaused);
  if (!round?.subMode) return;
  if (round.subMode === "A") openModal(dom.modalModeA);
  if (round.subMode === "B") openModal(dom.modalModeB);
  if (round.subMode === "C") openModal(dom.modalModeC);
}

function ensureRoundRendered(round) {
  try {
    if (!round) return;
    const key = `${round.id || "?"}_${round.stage || "?"}`;
    
    // 仅在阶段切换时触发弹窗动画
    if (key !== lastRenderedRoundKey) {
      lastRenderedRoundKey = key;
      openOverlayForRound(round);
    }
    
    // 每次数据更新都必须重新渲染内部内容，以反映玩家的提交状态
    renderRoundContent(round);
  } catch (error) {
    console.error("错误位置: [ensureRoundRendered], 原因:", error);
  }
}

function renderCountdown(round) {
  try {
    if (!round || isPauseActive()) return;
    const stage = round.stage;
    if (round.subMode === "A" && dom.modeACountdown) {
      dom.modeACountdownLabel.textContent = stage === "a_revealed" ? "秒后自动下一题" : "秒后自动结束";
      dom.modeACountdown.textContent = String(msToSecondsCeil((stage === "a_revealed" ? round.autoNextAt : round.endsAt) - nowMs()));
    }
    if (round.subMode === "B" && dom.modeBCountdown) {
      dom.modeBCountdownLabel.textContent = stage === "b_revealed" ? "秒后自动下一题" : "秒后自动结束";
      dom.modeBCountdown.textContent = String(msToSecondsCeil((stage === "b_revealed" ? round.autoNextAt : round.endsAt) - nowMs()));
    }
    if (round.subMode === "C" && dom.modeCCountdown) {
      dom.modeCCountdownLabel.textContent = stage === "c_revealed" ? "秒后自动下一题" : "秒后自动结束";
      dom.modeCCountdown.textContent = String(msToSecondsCeil((stage === "c_revealed" ? round.autoNextAt : round.endsAt) - nowMs()));
    }
  } catch (error) {
    console.error("错误位置: [renderCountdown], 原因:", error);
  }
}


function renderRoundContent(round) {
  if (round.subMode === "A") return renderModeA(round);
  if (round.subMode === "B") return renderModeB(round);
  if (round.subMode === "C") return renderModeC(round);
}

// ============================================================
// 界面渲染逻辑：Mode A (百科冷知识)
// ============================================================

function bindModeAOptionEnabled(enabled) {
  try {
    if (!dom.modeAOptions) return;
    dom.modeAOptions.querySelectorAll(".modal-option").forEach((btn) => {
      btn.disabled = !enabled;
      btn.style.opacity = enabled ? "1" : "0.75";
    });
  } catch (error) {
    console.error("错误位置: [bindModeAOptionEnabled], 原因:", error);
  }
}

function renderModeAOptions(options) {
  try {
    if (!dom.modeAOptions || !options) return;
    dom.modeAOptions.querySelectorAll(".modal-option").forEach((btn) => {
      const key = btn.dataset.option;
      const textEl = btn.querySelector(".modal-option-text");
      if (textEl) textEl.textContent = options[key] || "";
    });
  } catch (error) {
    console.error("错误位置: [renderModeAOptions], 原因:", error);
  }
}

function renderModeA(round) {
  try {
    const stage = round.stage;
    const participants = round.participantIds || [];
    const subs = getSubmissionsForRound();
    
    // 变量提升
    const mySubmitted = !!subs[myPlayerId];
    const canAnswer = stage === "a_answer" && participants.includes(myPlayerId) && !mySubmitted;

    dom.modeAResults.style.display = "none";
    dom.modeAWaiting.style.display = "none";
    dom.modeAOptions.style.display = "none";
    
    // 1. 新增：每次刷新时，默认隐藏最终排行榜容器
    if (dom.modeAFinalBoard) dom.modeAFinalBoard.style.display = "none";
    if (dom.modeACountdown) dom.modeACountdown.style.display = "block";
    if (dom.modeACountdownLabel) dom.modeACountdownLabel.style.display = "block";
    dom.modeADecode.textContent = round.decode || "";
    dom.modeAQuestion.textContent = round.question || "等待生成题目……";

    if (!stage || stage === "init") {
      dom.modeAWaiting.style.display = "block";
      dom.modeAWaiting.textContent = "等待生成题目……";
      return renderCountdown(round);
    }

    if (stage === "a_answer") {
      dom.modeAOptions.style.display = canAnswer ? "flex" : "none";
      dom.modeAWaiting.style.display = canAnswer ? "none" : "block";
      dom.modeAWaiting.textContent = mySubmitted ? "你已提交，等待揭晓……" : "等待其他玩家完成……";
      
      bindModeAOptionEnabled(canAnswer);
      renderModeAOptions(round.options);
      return renderCountdown(round);
    }

    if (stage === "a_revealed") {
      dom.modeAQuestion.textContent = "本轮揭晓结果：";
      dom.modeAResults.style.display = "block";
      
      renderModeAOptions(round.options);
      renderModeAResults(round);
      return renderCountdown(round);
    }

    // 2. 新增：处理最终结算排行榜阶段
    if (stage === "a_final_leaderboard") {
      dom.modeAQuestion.textContent = "游戏结束！";
      if (dom.modeAFinalBoard) dom.modeAFinalBoard.style.display = "block";
      
      // 隐藏倒计时组件
      if (dom.modeACountdown) dom.modeACountdown.style.display = "none";
      if (dom.modeACountdownLabel) dom.modeACountdownLabel.style.display = "none";
      
      // 调用负责渲染排行榜的专属函数
      renderModeAFinalLeaderboard(round);
      return;
    }

  } catch (error) {
    console.error("错误位置: [renderModeA], 原因:", error);
  }
}
function renderModeAResults(round) {
  try {
    const participants = round.participantIds || [];
    const results = round.results || {};
    dom.modeAResultsList.innerHTML = "";
    
    participants.forEach((playerId) => {
      const meta = ANIMAL_META[localState.players[playerId]?.animalKey] || { label: playerId, emoji: "❓" };
      const r = results[playerId] || {};
      const optionKey = r.optionKey;
      const status = !optionKey ? "未作答" : (r.isCorrect ? "回答正确" : "回答错误");
      
      const item = document.createElement("div");
      item.className = "modal-results-item";
      item.innerHTML = `
        <div class="modal-results-item-left">
          <span class="modal-results-item-emoji" aria-hidden="true">${meta.emoji}</span>
          <span>${meta.label}</span>
        </div>
        <div class="modal-results-item-right">
          ${status}${optionKey ? "（选 " + optionKey + "）" : ""}
        </div>
      `;
      dom.modeAResultsList.appendChild(item);
    });
  } catch (error) {
    console.error("错误位置: [renderModeAResults], 原因:", error);
  }
}

function renderModeAFinalLeaderboard(round) {
  try {
    const participants = round.participantIds || [];
    const session = localState.gameState?.session || { scores: {} };
    const scores = session.scores || {};

    // 1. 数据转换为数组，并引入多条件自定义排序
    const scoreboard = participants.map(playerId => {
      return {
        id: playerId,
        score: scores[playerId] || 0,
        meta: ANIMAL_META[localState.players[playerId]?.animalKey] || { label: playerId, emoji: "❓" }
      };
    }).sort((a, b) => {
      // 首要条件：按分数降序排列
      if (b.score !== a.score) {
        return b.score - a.score; 
      }
      // 次要条件：分数相同时，把当前玩家自己排在前面
      if (a.id === myPlayerId) return -1;
      if (b.id === myPlayerId) return 1;
      return 0;
    });

    // 2. 预处理标准竞争排名 (例如：1, 1, 3, 4)
    let previousScore = null;
    let currentRank = 1;
    scoreboard.forEach((player, index) => {
      if (player.score !== previousScore) {
        // 如果分数发生变化，名次直接跃升到当前的物理索引 + 1
        currentRank = index + 1;
      }
      player.rank = currentRank;
      previousScore = player.score;
    });

    // 3. 渲染排行榜列表 HTML
    if (dom.finalLeaderboardList) {
      dom.finalLeaderboardList.innerHTML = scoreboard.map(player => {
        const rank = player.rank;
        const isWinner = rank === 1; // 只要名次计算出是 1，就享有第一名的视觉待遇
        const isMe = player.id === myPlayerId;
        
        // 动态拼接 CSS 类名以触发高亮
        let rowClasses = "final-player-row";
        if (isWinner) rowClasses += " is-winner";
        if (isMe) rowClasses += " is-me";

        // 如果是第一名，追加皇冠 HTML
        const crownHtml = isWinner ? `<span class="crown-icon" aria-hidden="true">👑</span>` : "";

        return `
          <div class="${rowClasses}">
            <div class="final-player-rank">#${rank}</div>
            <div class="final-player-info">
              <span aria-hidden="true">${player.meta.emoji}</span>
              <span>${player.meta.label}</span>
              ${crownHtml}
            </div>
            <div class="final-player-score">答对 ${player.score} 题</div>
          </div>
        `;
      }).join("");
    }

    // 4. 处理当前玩家的动画反馈
    // 逻辑简化：直接根据预处理好的 rank 属性来判断自己是否为第一名
    const myPlayerData = scoreboard.find(p => p.id === myPlayerId);
    const amIWinner = myPlayerData && myPlayerData.rank === 1 && myPlayerData.score > 0;

    if (dom.finalFeedbackIcon && dom.finalFeedbackText) {
      dom.finalFeedbackIcon.className = "";
      void dom.finalFeedbackIcon.offsetWidth; 

      if (amIWinner) {
        dom.finalFeedbackIcon.textContent = pickRandom(["😎", "🏆", "🎉"]);
        dom.finalFeedbackText.textContent = pickRandom(["你，了不起！", "解锁称号：聪明小拉", "大脑是最好的肝脏捍卫者"]);
        dom.finalFeedbackIcon.classList.add("animate-winner");
      } else {
        dom.finalFeedbackIcon.textContent = pickRandom(["😭", "🥲", "🫠"]);
        dom.finalFeedbackText.textContent = pickRandom(["喝一杯吧，又能怎！", "是为了酒精装傻对吗", "死了啦，都是特朗普害的啦"]);
        dom.finalFeedbackIcon.classList.add("animate-loser");
      }
      
      dom.finalFeedbackText.style.opacity = "1";
    }

  } catch (error) {
    console.error("错误位置: [renderModeAFinalLeaderboard], 原因:", error);
  }
}


// ============================================================
// 界面渲染逻辑：Mode B (真心话雷达)
// ============================================================

function bindModeBOptionsEnabled(enabled) {
  try {
    if (!dom.modeBOptions) return;
    dom.modeBOptions.querySelectorAll(".modal-option").forEach((btn) => {
      btn.disabled = !enabled;
      btn.style.opacity = enabled ? "1" : "0.75";
    });
  } catch (error) {
    console.error("错误位置: [bindModeBOptionsEnabled], 原因:", error);
  }
}

function renderModeB(round) {
  try {
    const stage = round.stage;
    const participants = round.participantIds || [];
    const subs = getSubmissionsForRound();
    
    // 1. 初始化：每次刷新画面前，先把所有特种面板全部隐藏
    dom.modeBResults.style.display = "none";
    dom.modeBWaiting.style.display = "none";
    dom.modeBOptions.style.display = "none";
    if (dom.modeBSpeakBox) dom.modeBSpeakBox.style.display = "none";

    // 新增修复：如果没有结束时间戳，就把倒计时组件连根拔起（隐藏）
    const hasCountdown = round.endsAt != null || round.autoNextAt != null;
    if (dom.modeBCountdown) dom.modeBCountdown.style.display = hasCountdown ? "block" : "none";
    if (dom.modeBCountdownLabel) dom.modeBCountdownLabel.style.display = hasCountdown ? "block" : "none";

    // 2. 查户口：必须在所有的 if 判断之前，先把 Target 的身份查明！
    const targetId = round.targetPlayerId;
    const targetMeta = ANIMAL_META[localState.players[targetId]?.animalKey] || { label: "神秘人" };
    const isTarget = myPlayerId === targetId;
    const mySubmitted = !!subs[myPlayerId];

    // 3. 开始根据舞台（stage）分发剧本
    if (!stage || stage === "init") {
      dom.modeBWaiting.style.display = "block";
      dom.modeBWaiting.textContent = "等待生成吐槽问题……";
      return renderCountdown(round);
    }

    if (stage === "b_target_choice") {
      dom.modeBQuestion.textContent = round.question || "";
      dom.modeBWaiting.style.display = "block";
      
      dom.modeBWaiting.textContent = isTarget 
        ? "你正在选择真心话/谎话……" 
        : `等待 ${targetMeta.label} 完成选择……`;
      
      dom.modeBOptions.style.display = isTarget ? "flex" : "none";
      bindModeBOptionsEnabled(isTarget && !mySubmitted);
      return renderCountdown(round);
    }

    if (stage === "b_target_speak") {
      dom.modeBQuestion.textContent = round.question || "";
      
      if (isTarget) {
        dom.modeBWaiting.style.display = "block";
        dom.modeBWaiting.textContent = "开始你的表演！";
        if (dom.modeBSpeakBox) dom.modeBSpeakBox.style.display = "flex";
      } else {
        dom.modeBWaiting.style.display = "block";
        dom.modeBWaiting.textContent = `等待 ${targetMeta.label} 完成发言……`;
      }
      return renderCountdown(round);
    }

    if (stage === "b_vote") {
      dom.modeBQuestion.textContent = `猜测：${targetMeta.label} 选了真心话还是谎话？`;
      
      const canVote = !isTarget && participants.includes(myPlayerId) && !mySubmitted;
      
      dom.modeBWaiting.style.display = "block";
      dom.modeBWaiting.textContent = isTarget 
        ? "大家正在猜测你的选择……" 
        : (mySubmitted ? "你已投票，等待揭晓……" : "现在请投票猜测！");
      
      dom.modeBOptions.style.display = canVote ? "flex" : "none";
      bindModeBOptionsEnabled(canVote);
      return renderCountdown(round);
    }

    if (stage === "b_revealed") {
      dom.modeBQuestion.textContent = "雷达结果揭晓：";
      dom.modeBResults.style.display = "block";
      renderModeBResults(round);
      return renderCountdown(round);
    }
  } catch (error) {
    console.error("错误位置: [renderModeB], 原因:", error);
  }
}

function renderModeBResults(round) {
  try {
    const results = round.results || {};
    const targetId = results.targetPlayerId;
    const targetChoice = results.targetChoice;
    const votes = results.votes || {};
    const participants = round.participantIds || [];
    const targetMeta = ANIMAL_META[localState.players[targetId]?.animalKey] || { label: "神秘人", emoji: "❓" };

    dom.modeBResultsList.innerHTML = "";
    
    // 渲染 Target 的选择结果
    const header = document.createElement("div");
    header.className = "modal-results-item";
    header.innerHTML = `
      <div class="modal-results-item-left">
        <span class="modal-results-item-emoji" aria-hidden="true">${targetMeta.emoji}</span>
        <span>Target（${targetMeta.label}）</span>
      </div>
      <div class="modal-results-item-right">${targetChoice === "truth" ? "选了真心话" : "选了谎话"}</div>
    `;
    dom.modeBResultsList.appendChild(header);

    // 渲染其他玩家的猜测结果
    participants.forEach((playerId) => {
      if (playerId === targetId) return;
      const meta = ANIMAL_META[localState.players[playerId]?.animalKey] || { label: playerId, emoji: "❓" };
      const v = votes[playerId];
      const status = !v ? "未作答" : (v.isCorrect ? "猜对了" : "猜错了");
      const guessText = !v ? "" : (v.guess === "truth" ? "真心话" : "谎话");
      
      const item = document.createElement("div");
      item.className = "modal-results-item";
      item.innerHTML = `
        <div class="modal-results-item-left">
          <span class="modal-results-item-emoji" aria-hidden="true">${meta.emoji}</span>
          <span>${meta.label}</span>
        </div>
        <div class="modal-results-item-right">${status}${guessText ? "（猜 " + guessText + "）" : ""}</div>
      `;
      dom.modeBResultsList.appendChild(item);
    });
  } catch (error) {
    console.error("错误位置: [renderModeBResults], 原因:", error);
  }
}

// ============================================================
// 界面渲染逻辑：Mode C (卧室大冒险)
// ============================================================

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderModeC(round) {
  try {
    const stage = round.stage;
    const subs = getSubmissionsForRound();
    
    dom.modeCResults.style.display = "none";
    dom.modeCWaiting.style.display = "none";
    dom.modeCOptions.style.display = "none";

    // 变量提升：获取 Target 的名字，准备用于文案替换
    const targetId = round.targetPlayerId;
    const targetMeta = ANIMAL_META[localState.players[targetId]?.animalKey] || { label: "神秘人", emoji: "❓" };
    const isTarget = myPlayerId === targetId;
    const mySubmitted = !!subs[myPlayerId];

    if (!stage || stage === "init") {
      dom.modeCMission.textContent = "卧室大冒险";
      dom.modeCWaiting.style.display = "block";
      dom.modeCWaiting.textContent = "等待生成任务……";
      return renderCountdown(round);
    }

    if (stage === "c_mission") {
      dom.modeCMission.textContent = round.mission || "";
      dom.modeCWaiting.style.display = "block";
      
      // 动态文案替换：把生硬的 "Target" 换成动物名称
      dom.modeCWaiting.textContent = isTarget 
        ? "请准备执行任务吧～" 
        : `等待 ${targetMeta.label} 完成任务……`;
      
      const canDone = isTarget && !mySubmitted;
      dom.modeCOptions.style.display = canDone ? "flex" : "none";
      dom.modeCOptions.querySelectorAll(".modal-option").forEach((btn) => {
        btn.disabled = !canDone;
        btn.style.opacity = canDone ? "1" : "0.75";
      });
      return renderCountdown(round);
    }

    if (stage === "c_revealed") {
      dom.modeCMission.textContent = "本轮任务回顾：";
      dom.modeCResults.style.display = "block";
      renderModeCResults(round);
      return renderCountdown(round);
    }
  } catch (error) {
    console.error("错误位置: [renderModeC], 原因:", error);
  }
}

function renderModeCResults(round) {
  try {
    const results = round.results || {};
    const targetId = results.targetPlayerId;
    const doneByTarget = !!results.doneByTarget;
    const mission = round.mission || "";
    const participants = round.participantIds || [];

    // 依然需要查询 Target 的名字，用于结算界面的播报
    const targetMeta = ANIMAL_META[localState.players[targetId]?.animalKey] || { label: "神秘人", emoji: "❓" };

    dom.modeCResultsList.innerHTML = "";
    const missionItem = document.createElement("div");
    missionItem.className = "modal-results-item";
    missionItem.innerHTML = `
      <div class="modal-results-item-left">
        <span class="modal-results-item-emoji" aria-hidden="true">🏠</span><span>任务</span>
      </div>
      <div class="modal-results-item-right" style="white-space: normal;">${escapeHtml(mission)}</div>
    `;
    dom.modeCResultsList.appendChild(missionItem);

    participants.forEach((playerId) => {
      const meta = ANIMAL_META[localState.players[playerId]?.animalKey] || { label: playerId, emoji: "❓" };
      const item = document.createElement("div");
      item.className = "modal-results-item";
      
      if (playerId !== targetId) {
        // 如果是围观群众
        item.innerHTML = `
          <div class="modal-results-item-left">
            <span class="modal-results-item-emoji" aria-hidden="true">${meta.emoji}</span><span>${meta.label}</span>
          </div>
          <div class="modal-results-item-right">观看中</div>
        `;
      } else {
        // 如果是 Target 本人，动态替换掉原本的“Target已完成”
        item.innerHTML = `
          <div class="modal-results-item-left">
            <span class="modal-results-item-emoji" aria-hidden="true">${meta.emoji}</span><span>${meta.label}</span>
          </div>
          <div class="modal-results-item-right">
            ${doneByTarget ? `${meta.label} 已完成！` : `时间到，${meta.label} 未完成`}
          </div>
        `;
      }
      dom.modeCResultsList.appendChild(item);
    });
  } catch (error) {
    console.error("错误位置: [renderModeCResults], 原因:", error);
  }
}

function tickUI() {
  try {
    if (localState.status !== "playing") return;
    if (isPauseActive()) return;
    const round = localState.gameState?.round;
    if (!round) return;
    renderCountdown(round);
  } catch (error) {
    console.error("错误位置: [tickUI], 原因:", error);
  }
}

function maybeRenderGame() {
  try {
    if (localState.status !== "playing") {
      hideAllGameModals();
      closeModal(dom.modalPaused);
      return;
    }
    const round = localState.gameState?.round;
    if (!round) return;
    openOverlayForRound(round);
    ensureRoundRendered(round);
  } catch (error) {
    console.error("错误位置: [maybeRenderGame], 原因:", error);
  }
}

// ============================================================
// 交互：Lobby/Hall/暂停
// ============================================================
async function joinParty() {
  try {
    if (!currentSelectedAnimalKey || !db) return;
    const myPlayerRef = ref(db, `${ROOM_PATH}/players/${myPlayerId}`);
    await set(myPlayerRef, { animalKey: currentSelectedAnimalKey, joinedAt: serverTimestamp() });
    try {
      onDisconnect(myPlayerRef).remove();
    } catch (error) {
      console.error("错误位置: [onDisconnect remove], 原因:", error);
    }
    await update(roomRootRef(), { status: "hall" });
  } catch (error) {
    console.error("错误位置: [joinParty], 原因:", error);
  }
}

async function gameLoopTick() {
  if (!db || localState.status !== "playing") return;

  const round = localState.gameState?.round;
  if (!round) return;

  try {
    const pause = localState.gameState.pause || {};

    if (pause.active) {
      if (pause.resumeRequested && !pause.resumedByHost) {
        if (await claimLock("resume_pause", 5000)) {
          // 🚨 修复时间幽灵：这里必须用我们自己写的 nowMs()，不能用 Date.now()！
          const delta = nowMs() - (pause.appliedAtMs || nowMs());
          const patch = {};
          if (pause.snapshot?.endsAt != null) patch["gameState/round/endsAt"] = pause.snapshot.endsAt + delta;
          if (pause.snapshot?.autoNextAt != null) patch["gameState/round/autoNextAt"] = pause.snapshot.autoNextAt + delta;

          await update(roomRootRef(), {
            ...patch,
            "gameState/pause/active": false,
            "gameState/pause/resumeRequested": false,
            "gameState/pause/appliedByHost": false,
            "gameState/pause/resumedByHost": true
          });
        }
      }
      return;
    }

    if (round.stage === "init") {
      if (await claimLock(`generate_${round.id}`, 15000)) {
        return await hostGenerateQuestionForRound(round);
      }
    }

    // 🌟 提取当前所有人的提交记录
    const currentSubs = getSubmissionsForRound();

    // 🌟 智能事件驱动：时间到了，或者（不管时间到没到）人全投完了，立刻开奖！
    if (shouldRevealByTime(round) || isRoundFullySubmitted(round, currentSubs)) {
      if (await claimLock(`reveal_${round.id}_${round.stage}`, 8000)) {
        return await hostRevealRound(round, currentSubs);
      }
    }

    if (isAutoNextDue(round)) {
      if (await claimLock(`next_${round.id}`, 8000)) {
        return await hostGenerateNextRoundAndQuestion(round);
      }
    }
  } catch (error) {
    console.error("状态机轮询异常:", error);
  }
}

// 初始化游戏状态引擎
async function requestStartParty(selectedMode) {
  if (!selectedMode || !db) return;
  
  try {
    const participantIds = Object.keys(localState.players || {});
    if (!participantIds.length) return;

    const roundId = makeRoundId();
    const subMode = selectedMode === "D" ? pickRandom(["A", "B", "C"]) : selectedMode;

    // 1. 新增：初始化玩家得分容器
    const initialScores = {};
    if (subMode === "A") {
      participantIds.forEach(playerId => {
        initialScores[playerId] = 0;
      });
    }

    // 2. 将数据合并写入 Firebase
    await update(roomRootRef(), {
      "status": "playing",
      "submissions": null, 
      "locks": null,
      "gameState/mode": selectedMode,
      "gameState/pause": { active: false },
      // 3. 新增：写入 session 状态（仅模式 A 启用）
      "gameState/session": subMode === "A" ? {
        questionCount: 1,
        scores: initialScores
      } : null,
      "gameState/round": {
        id: roundId,
        subMode: subMode,
        stage: "init",
        participantIds: participantIds,
        question: null, options: null, correct: null, decode: null, mission: null,
        targetPlayerId: null, targetChoice: null, results: null, endsAt: null, autoNextAt: null
      }
    });
  } catch (error) {
    console.error("引擎初始化失败:", error);
  }
}

// 调度当前回合的生成模型
async function hostGenerateQuestionForRound(round) {
  const subMode = round.subMode;
  const participantIds = Array.isArray(round.participantIds) && round.participantIds.length 
    ? round.participantIds 
    : Object.keys(localState.players || {});

  try {
    await clearSubmissions();
    if (subMode === "A") return await generateModeAQuestion(round.id, participantIds);
    if (subMode === "B") return await generateModeBQuestion(round.id, participantIds);
    if (subMode === "C") return await generateModeCQuestion(round.id, participantIds);
  } catch (error) {
    console.error(`模型调度异常 [模式 ${subMode}]:`, error);
  }
}

// 调度下一回合的生成模型
async function hostGenerateNextRoundAndQuestion(round) {
  const currentMode = localState.gameState.mode;
  const participantIds = Array.isArray(round.participantIds) && round.participantIds.length ? round.participantIds : Object.keys(localState.players || {});
  if (!participantIds.length) return;

  // ====== 核心拦截逻辑开始 ======
  if (round.subMode === "A") {
    const currentSession = localState.gameState?.session || { questionCount: 1, scores: {} };
    const currentCount = currentSession.questionCount || 1;

    // 如果已经完成 5 题
    if (currentCount >= 5) {
      console.log("【系统日志】触发第5题拦截，准备进入最终排行榜！");
      await clearSubmissions();
      
      // 核心修复：不要只改 stage，必须彻底覆写整个 round 对象，抹除上一题的残影
      await update(roomRootRef(), {
        "gameState/round": {
          id: round.id,
          subMode: "A",
          stage: "a_final_leaderboard",
          participantIds: participantIds,
          question: "游戏结束！结算中...", // 强制覆盖旧题目
          options: null,               // 强制清空选项
          correct: null,
          decode: null,
          results: null,
          endsAt: null,
          autoNextAt: null
        }
      });
      return; // 物理阻断，退出函数
    } else {
      // 还没到 5 题，题号 + 1
      await update(roomRootRef(), {
        "gameState/session/questionCount": currentCount + 1
      });
    }
  }
  // ====== 核心拦截逻辑结束 ======

  const nextSubMode = currentMode === "D" ? pickRandom(["A", "B", "C"]) : currentMode;
  const newRoundId = makeRoundId();

  await clearSubmissions();
  await update(roomRootRef(), { 
    "gameState/round": { 
      ...round, id: newRoundId, subMode: nextSubMode, stage: "init", 
      question: null, options: null, correct: null, decode: null, mission: null, 
      targetPlayerId: null, targetChoice: null, results: null, endsAt: null, autoNextAt: null, participantIds 
    } 
  });

  if (nextSubMode === "A") return generateModeAQuestion(newRoundId, participantIds);
  if (nextSubMode === "B") return generateModeBQuestion(newRoundId, participantIds);
  if (nextSubMode === "C") return generateModeCQuestion(newRoundId, participantIds);
}

// 通用分布式抢锁机制
async function claimLock(lockName, durationMs = 15000) {
  if (!db) return false;
  const lockRef = ref(db, `${ROOM_PATH}/locks/${lockName}`);
  try {
    const result = await runTransaction(lockRef, (current) => {
      const now = Date.now();
      // 验证当前锁状态：若存在且未过期，则放弃竞争
      if (current && current.locked && current.expiresAt > now) {
        return; 
      }
      // 写入当前客户端标识与锁过期时间
      return { locked: true, claimedBy: myPlayerId, expiresAt: now + durationMs };
    });
    // 确认事务已提交且持有者为当前客户端
    return result.committed && result.snapshot.val()?.claimedBy === myPlayerId;
  } catch (error) {
    console.error("并发锁竞争异常:", error);
    return false;
  }
}

// 替换原有的 requestPause 函数
async function requestPause() {
  if (!db) return;
  try {
    const round = localState.gameState?.round || {};
    await update(roomRootRef(), {
      "gameState/pause": { // 🚨 点改成了斜杠
        active: true,
        appliedByHost: true,
        requestedBy: myPlayerId,
        appliedAtMs: Date.now(),
        snapshot: {
          endsAt: round.endsAt || null,
          autoNextAt: round.autoNextAt || null
        }
      }
    });
    console.log("[指令] 暂停请求已强制下发");
  } catch (error) {
    console.error("强制暂停失败:", error);
  }
}

async function requestContinue() {
  if (!db) return;
  try {
    await update(roomRootRef(), { "gameState/pause/resumeRequested": true }); // 🚨
  } catch (error) {
    console.error("错误位置: [requestContinue], 原因:", error);
  }
}

async function requestReturnHall() {
  if (!db) return;
  try {
    await update(roomRootRef(), {
      status: "hall",
      "gameState/mode": null, // 🚨
      "gameState/round": null, // 🚨
      "gameState/pause": { active: false } // 🚨
    });
  } catch (error) {
    console.error("错误位置: [requestReturnHall], 原因:", error);
  }
}

// ============================================================
// 提交：Mode A/B/C
// ============================================================
async function submitModeA(optionKey) {
  const round = localState.gameState?.round;
  if (!round || round.subMode !== "A" || round.stage !== "a_answer") return;
  if (isPauseActive()) return;
  try {
    const participants = round.participantIds || [];
    if (!participants.includes(myPlayerId)) return;
    const subs = getSubmissionsForRound();
    if (subs[myPlayerId]) return;
    await update(ref(db, `${ROOM_PATH}/submissions/${round.id}/${myPlayerId}`), {
      optionKey,
      submittedAt: serverTimestamp()
    });
  } catch (error) {
    console.error("错误位置: [submitModeA], 原因:", error);
  }
}

// 1. 玩家点击“真心话/谎话”或“猜测”时的提交逻辑
async function submitModeB(val) {
  const round = localState.gameState?.round;
  if (!round || round.subMode !== "B") return;
  if (isPauseActive()) return;
  try {
    const subs = getSubmissionsForRound();

    if (round.stage === "b_target_choice") {
      if (round.targetPlayerId !== myPlayerId) return;
      if (subs[myPlayerId]) return; // 防止狂点按钮重复提交

      // 核心修改：目标玩家选择后，强制改变系统状态进入发言阶段，并清空倒计时
      await update(roomRootRef(), { 
        [`submissions/${round.id}/${myPlayerId}`]: { choice: val, submittedAt: serverTimestamp() },
        "gameState/round/stage": "b_target_speak",
        "gameState/round/endsAt": null 
      });
      return;
    }
    
    if (round.stage === "b_vote") {
      if (round.targetPlayerId === myPlayerId) return;
      if (subs[myPlayerId]) return;
      const participants = round.participantIds || [];
      if (!participants.includes(myPlayerId)) return;
      
      // 记录围观群众的投票
      await update(ref(db, `${ROOM_PATH}/submissions/${round.id}/${myPlayerId}`), { guess: val, submittedAt: serverTimestamp() });
    }
  } catch (error) {
    console.error("错误位置: [submitModeB], 原因:", error);
  }
}

// 2. 玩家点击“发言结束”的专属逻辑
async function submitModeB_finishSpeak() {
  const round = localState.gameState?.round;
  if (!round || round.subMode !== "B" || round.stage !== "b_target_speak") return;
  if (isPauseActive()) return;
  try {
    if (round.targetPlayerId !== myPlayerId) return;
    
    // 发言结束后，进入投票阶段，重新启动20秒倒计时
    const startedAt = nowMs();
    const endsAt = startedAt + (GAMEMODE_DURATION_SECONDS.B || 20) * 1000;
    
    await update(roomRootRef(), {
      "gameState/round/stage": "b_vote",
      "gameState/round/startedAt": startedAt,
      "gameState/round/endsAt": endsAt
    });
  } catch (error) {
    console.error("错误位置: [submitModeB_finishSpeak], 原因:", error);
  }
}

async function submitModeC_done() {
  const round = localState.gameState?.round;
  if (!round || round.subMode !== "C" || round.stage !== "c_mission") return;
  if (isPauseActive()) return;
  try {
    if (round.targetPlayerId !== myPlayerId) return;
    const subs = getSubmissionsForRound();
    if (subs[myPlayerId]) return;
    await update(ref(db, `${ROOM_PATH}/submissions/${round.id}/${myPlayerId}`), { done: true, submittedAt: serverTimestamp() });
  } catch (error) {
    console.error("错误位置: [submitModeC_done], 原因:", error);
  }
}

// ============================================================
// 主控推进（Bluey）: init -> reveal -> autoNext
// ============================================================
function shouldRevealByTime(round) {
  if (!round.endsAt || typeof round.endsAt !== "number") return false;
  if (nowMs() < round.endsAt) return false;
  return ["a_answer", "b_target_choice", "b_vote", "c_mission"].includes(round.stage);
}

function isRoundFullySubmitted(round, subs) {
  try {
    const participants = round.participantIds || [];
    if (!participants.length) return false;

    // 针对 Mode B 的投票阶段：排除 Target 本人，看剩余的吃瓜群众是否全部投完
    if (round.subMode === "B" && round.stage === "b_vote") {
      const targetId = round.targetPlayerId;
      const voters = participants.filter(p => p !== targetId);
      if (voters.length === 0) return false;
      return voters.every(p => subs[p] && subs[p].guess);
    }

    // 🌟 新增：针对 Mode A 的全员答题阶段：所有人必须都投完才算数
    if (round.subMode === "A" && round.stage === "a_answer") {
      // .every() 的意思是：必须每一个玩家(p)都在数据库里留下了 optionKey（也就是选了ABCD）
      return participants.every(p => subs[p] && subs[p].optionKey);
    }

    // 后续如果你想加 Mode C 的全员判断，也可以写在这里
    return false;
  } catch (error) {
    console.error("错误位置: [isRoundFullySubmitted], 原因:", error);
    return false;
  }
}

function isAutoNextDue(round) {
  if (!round.autoNextAt || typeof round.autoNextAt !== "number") return false;
  if (nowMs() < round.autoNextAt) return false;
  return String(round.stage || "").endsWith("_revealed");
}

async function hostHandlePause() {
  try {
    const pause = localState.gameState.pause || {};
    if (!pause.active) return;
    const round = localState.gameState.round || {};

    if (!pause.appliedByHost) {
      const snapshot = {
        endsAt: typeof round.endsAt === "number" ? round.endsAt : null,
        autoNextAt: typeof round.autoNextAt === "number" ? round.autoNextAt : null
      };
      await update(roomRootRef(), {
        "gameState/pause": { ...pause, appliedByHost: true, snapshot, appliedAtMs: Date.now() }
      });
      return;
    }

    if (pause.resumeRequested && !pause.resumedByHost) {
      const delta = Date.now() - (pause.appliedAtMs || Date.now());
      const patch = {};
      // 🚨 修正路径：点号全改斜杠
      if (pause.snapshot?.endsAt != null) patch["gameState/round/endsAt"] = pause.snapshot.endsAt + delta;
      if (pause.snapshot?.autoNextAt != null) patch["gameState/round/autoNextAt"] = pause.snapshot.autoNextAt + delta;

      await update(roomRootRef(), {
        ...patch,
        "gameState/pause/active": false,
        "gameState/pause/resumeRequested": false,
        "gameState/pause/appliedByHost": false,
        "gameState/pause/resumedByHost": true
      });
    }
  } catch (error) {
    console.error("错误位置: [hostHandlePause], 原因:", error);
  }
}

async function clearSubmissions() {
  try {
    // 🚨 核心修复：Firebase update 不接受 {}，必须用 null 来物理清空路径
    await update(roomRootRef(), { submissions: null }); 
  } catch (error) {
    console.error("错误位置: [clearSubmissions], 原因:", error);
  }
}


async function hostRevealRound(round, submissionsForRound) {
  const subMode = round.subMode;
  if (subMode === "A" && round.stage === "a_answer") return revealModeA(round, submissionsForRound);
  if (subMode === "B" && round.stage === "b_target_choice") return revealModeB_targetChoice(round, submissionsForRound);
  if (subMode === "B" && round.stage === "b_vote") return revealModeB_vote(round, submissionsForRound);
  if (subMode === "C" && round.stage === "c_mission") return revealModeC(round, submissionsForRound);
}


async function generateModeBQuestion(roundId, participantIds) {
  // 同样加入短路截断，强制使用本地题库
  return applyModeBFallback(roundId, participantIds);

  if (!ensureGeminiModel()) return applyModeBFallback(roundId, participantIds);
  try {
    const targetPlayerId = pickRandom(participantIds);
    // 从题库中提取下一道未使用的问题及最新的索引状态
    const { fallbackData, newUsedIndices } = getNextFallbackQuestionB();
    
    const prompt = `为 Mode B 生成一个针对 Target 的日常小癖好/轻微社死吐槽问题。只输出严格有效 JSON：{"question":"..."}。
Language: 简体中文；避免恋爱、男士、性或露骨内容；不要包含“真/假/Truth/Lie”等字眼。`;
    const result = await geminiModel.generateContent(prompt);
    const rawText = result?.response ? result.response.text() : "";
    const parsed = parseJsonSafely(rawText);
    
    const isAIValid = !!parsed?.question;
    const question = isAIValid ? parsed.question : fallbackData.question;

    const startedAt = nowMs();
    const endsAt = startedAt + (GAMEMODE_DURATION_SECONDS.B || 20) * 1000;
    
    const patchData = {
      "gameState/round": { 
        ...localState.gameState?.round, 
        id: roundId, 
        subMode: "B", 
        stage: "b_target_choice", 
        participantIds, 
        targetPlayerId, 
        question, 
        targetChoice: null, 
        startedAt, 
        endsAt, 
        autoNextAt: null, 
        revealedAt: null, 
        results: null 
      }
    };

    if (!isAIValid) {
      patchData["gameState/usedModeBIndices"] = newUsedIndices;
    }

    await update(roomRootRef(), patchData);
  } catch (error) {
    console.error("错误位置: [generateModeBQuestion], 原因:", error);
    await applyModeBFallback(roundId, participantIds);
  }
}

async function applyModeBFallback(roundId, participantIds) {
  try {
    const targetPlayerId = pickRandom(participantIds);
    // 降级模式下，直接读取静态题库并获取新索引
    const { fallbackData, newUsedIndices } = getNextFallbackQuestionB();
    
    const startedAt = nowMs();
    const endsAt = startedAt + (GAMEMODE_DURATION_SECONDS.B || 20) * 1000;
    
    await update(roomRootRef(), { 
      "gameState/usedModeBIndices": newUsedIndices,
      "gameState/round": { 
        ...localState.gameState?.round, 
        id: roundId, 
        subMode: "B", 
        stage: "b_target_choice", 
        participantIds, 
        targetPlayerId, 
        question: fallbackData?.question || "（兜底备用）你有没有那种别人看不出来但你自己很坚持的小习惯？", 
        targetChoice: null, 
        startedAt, 
        endsAt, 
        autoNextAt: null, 
        revealedAt: null, 
        results: null 
      } 
    });
  } catch (error) {
    console.error("错误位置: [applyModeBFallback], 原因:", error);
  }
}

async function generateModeCQuestion(roundId, participantIds) {
  return applyModeCFallback(roundId, participantIds);
  if (!ensureGeminiModel()) return applyModeCFallback(roundId, participantIds);
  try {
    const targetPlayerId = pickRandom(participantIds);
    // 获取下一道未使用的题目以及更新后的索引列表
    const { fallbackData, newUsedIndices } = getNextFallbackMissionC();
    
    const prompt = `为 Mode C 生成一个适合在卧室/客厅用常见物品完成的搞笑小任务。只输出严格有效 JSON：{"mission":"..."}。
mission 简体中文，避免恋爱、男士、性或露骨内容。`;
    const result = await geminiModel.generateContent(prompt);
    const rawText = result?.response ? result.response.text() : "";
    const parsed = parseJsonSafely(rawText);
    
    const isAIValid = !!parsed?.mission;
    const mission = isAIValid ? parsed.mission : fallbackData.mission;

    const startedAt = nowMs();
    const endsAt = startedAt + (GAMEMODE_DURATION_SECONDS.C || 60) * 1000;
    
    const patchData = {
      "gameState/round": {
        ...localState.gameState?.round,
        id: roundId,
        subMode: "C",
        stage: "c_mission",
        participantIds,
        targetPlayerId,
        mission,
        startedAt,
        endsAt,
        autoNextAt: null,
        revealedAt: null,
        results: null
      }
    };

    // 只有当 AI 生成失败，实际动用了备用题库时，才消耗该题的索引
    if (!isAIValid) {
      patchData["gameState/usedModeCIndices"] = newUsedIndices;
    }

    await update(roomRootRef(), patchData);
  } catch (error) {
    console.error("错误位置: [generateModeCQuestion], 原因:", error);
    await applyModeCFallback(roundId, participantIds);
  }
}

async function applyModeCFallback(roundId, participantIds) {
  try {
    const targetPlayerId = pickRandom(participantIds);
    // 直接获取未使用的备用题和新索引
    const { fallbackData, newUsedIndices } = getNextFallbackMissionC();
    
    const startedAt = nowMs();
    const endsAt = startedAt + (GAMEMODE_DURATION_SECONDS.C || 60) * 1000;
    
    await update(roomRootRef(), {
      "gameState/usedModeCIndices": newUsedIndices, // 将更新后的已用索引写入数据库
      "gameState/round": {
        ...localState.gameState?.round,
        id: roundId,
        subMode: "C",
        stage: "c_mission",
        participantIds,
        targetPlayerId,
        mission: fallbackData?.mission || "（兜底备用）做一个极其夸张的伸懒腰动作",
        startedAt,
        endsAt,
        autoNextAt: null,
        revealedAt: null,
        results: null
      }
    });
  } catch (error) {
    console.error("错误位置: [applyModeCFallback], 原因:", error);
  }
}


// ============================================================
// Reveal（host 写回 gameState）
async function revealModeA(round, submissionsForRound) {
  try {
    const participantIds = round.participantIds || [];
    const results = {};
    
    // 1. 调取当前的计分板
    const currentSession = localState.gameState?.session || { questionCount: 1, scores: {} };
    const newScores = { ...currentSession.scores };

    participantIds.forEach((playerId) => {
      const sub = submissionsForRound[playerId] || {};
      const optionKey = sub.optionKey || null;
      const isCorrect = (optionKey && round.correct) ? (optionKey === round.correct) : false;
      results[playerId] = { optionKey, isCorrect };

      // 2. 如果答对，分数加 1
      if (isCorrect) {
        newScores[playerId] = (newScores[playerId] || 0) + 1;
      }
    });

    const revealedAt = nowMs();
    
    // 3. 准备向数据库发送的更新包
    const patchData = { 
      "gameState/round": { ...round, stage: "a_revealed", results, revealedAt, autoNextAt: revealedAt + 7000 },
      "gameState/session/scores": newScores 
    };

    await update(roomRootRef(), patchData);
  } catch (error) {
    console.error("错误位置: [revealModeA], 原因:", error);
  }
}

// 修复主机（Host）自动推进逻辑：如果时间到了Target还没选，强制推入发言阶段，而不是直接跳去投票
async function revealModeB_targetChoice(round, submissionsForRound) {
  try {
    const targetId = round.targetPlayerId;
    const targetSub = submissionsForRound[targetId] || {};
    // 如果倒计时结束他还没选，系统帮他随机选一个
    const targetChoice = targetSub.choice || pickRandom(["truth", "lie"]);
    
    // 倒计时结束后，不再进入 b_vote，而是强制进入 b_target_speak 让他发言！
    await update(roomRootRef(), { 
      [`submissions/${round.id}/${targetId}`]: { choice: targetChoice, submittedAt: serverTimestamp() },
      "gameState/round/stage": "b_target_speak", 
      "gameState/round/endsAt": null 
    });
  } catch (error) {
    console.error("错误位置: [revealModeB_targetChoice], 原因:", error);
  }
}

async function revealModeB_vote(round, submissionsForRound) {
  try {
    const targetId = round.targetPlayerId;
    const targetChoice = round.targetChoice || "truth";
    const participantIds = round.participantIds || [];
    const votes = {};
    participantIds.forEach((playerId) => {
      if (playerId === targetId) return;
      const sub = submissionsForRound[playerId] || {};
      const guess = sub.guess || null;
      if (!guess) return;
      votes[playerId] = { guess, isCorrect: guess === targetChoice };
    });
    const revealedAt = nowMs();
    const results = { targetPlayerId: targetId, targetChoice, votes };
    await update(roomRootRef(), { "gameState/round": { ...round, stage: "b_revealed", results, revealedAt, autoNextAt: revealedAt + 10000 } });
  } catch (error) {
    console.error("错误位置: [revealModeB_vote], 原因:", error);
  }
}

async function revealModeC(round, submissionsForRound) {
  try {
    const targetId = round.targetPlayerId;
    const targetSub = submissionsForRound[targetId] || {};
    const doneByTarget = !!targetSub.done;
    const revealedAt = nowMs();
    await update(roomRootRef(), { "gameState/round": { ...round, stage: "c_revealed", results: { targetPlayerId: targetId, doneByTarget }, revealedAt, autoNextAt: revealedAt + 10000 } });
  } catch (error) {
    console.error("错误位置: [revealModeC], 原因:", error);
  }
}

// ============================================================
// 初始化与事件绑定
// ============================================================

// ============================================================
// 初始化与事件绑定
// ============================================================
// ============================================================
// 初始化与事件绑定 (下半身核心代码)
// ============================================================
let listenersAttached = false;
function attachFirebaseListeners() {
  if (listenersAttached || !db) return;
  listenersAttached = true;
  try {
    // 时间校准频道
    onValue(ref(db, ".info/serverTimeOffset"), (snap) => {
      if (typeof serverTimeOffset !== 'undefined') {
        serverTimeOffset = snap.val() || 0;
      }
    });

    onValue(playersRef(), (snap) => {
      localState.players = snap.val() || {};
      refreshViewForJoinState();
      renderHallPlayers();
      refreshModeButtons();
      refreshAnimalSelectionUI(); 
      maybeRenderGame();
      
      // 当 Firebase 数据成功传回来后，隐藏加载文字
      if (dom.lobbyLoadingStatus) dom.lobbyLoadingStatus.style.display = "none";
    });
    
    onValue(statusRef(), (snap) => {
      localState.status = snap.val() || "lobby";
      refreshViewForJoinState();
      maybeRenderGame();
    });
    
    onValue(gameStateRef(), (snap) => {
      localState.gameState = snap.val() || {};
      maybeRenderGame();
    });
    
    onValue(submissionsRef(), (snap) => {
      localState.submissions = snap.val() || {};
      maybeRenderGame();
    });

    onValue(ref(db, GLOBAL_HISTORY_PATH), (snap) => {
      localState.globalHistory = snap.val() || {};
    });
  } catch (error) {
    console.error("错误位置: [attachFirebaseListeners], 原因:", error);
  }
}

function bindDomEvents() {
  try {
    if (dom.animalList) {
      dom.animalList.querySelectorAll(".animal-card").forEach((card) => {
        card.addEventListener("click", () => {
          try {
            if (card.dataset.disabled === "true") {
              openModal(dom.modalAnimalTaken);
              return;
            }
            const animalKey = card.dataset.animal;
            const wasSelected = currentSelectedAnimalKey === animalKey;
            dom.animalList.querySelectorAll(".animal-card").forEach((c) => c.classList.remove("animal-card-selected"));
            currentSelectedAnimalKey = wasSelected ? null : animalKey;
            if (currentSelectedAnimalKey) card.classList.add("animal-card-selected");
            refreshLobbyUI();
          } catch (error) {
            console.error("错误位置: [动物选择 click], 原因:", error);
          }
        });
      });
    }
  } catch (error) {
    console.error("错误位置: [bind animalList], 原因:", error);
  }

  try {
    dom.btnAnimalTakenOk?.addEventListener("click", () => closeModal(dom.modalAnimalTaken));
    dom.modalAnimalTakenClose?.addEventListener("click", () => closeModal(dom.modalAnimalTaken));
  } catch (error) {
    console.error("错误位置: [bind animal taken modal], 原因:", error);
  }

  try {
    dom.joinBtn?.addEventListener("click", () => joinParty().catch((e) => console.error("错误位置: [joinBtn click], 原因:", e)));
  } catch (error) {
    console.error("错误位置: [bind joinBtn], 原因:", error);
  }

  try {
    dom.modeList?.querySelectorAll(".mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        try {
          pendingStartMode = btn.dataset.mode;
          openModal(dom.modalConfirmStart);
        } catch (error) {
          console.error("错误位置: [mode btn click], 原因:", error);
        }
      });
    });
  } catch (error) {
    console.error("错误位置: [bind modeList], 原因:", error);
  }

  try {
    dom.btnConfirmStart?.addEventListener("click", () => {
      closeModal(dom.modalConfirmStart);
      requestStartParty(pendingStartMode).catch((e) => console.error("错误位置: [confirm start click], 原因:", e));
    });
    dom.btnCancelStart?.addEventListener("click", () => closeModal(dom.modalConfirmStart));
    dom.btnConfirmStartClose?.addEventListener("click", () => closeModal(dom.modalConfirmStart));
  } catch (error) {
    console.error("错误位置: [bind confirm modal], 原因:", error);
  }

  try {
    dom.btnPauseContinue?.addEventListener("click", () => requestContinue().catch((e) => console.error("错误位置: [pause continue], 原因:", e)));
    dom.btnPauseClose?.addEventListener("click", () => requestContinue().catch((e) => console.error("错误位置: [pause close], 原因:", e)));
    dom.btnPauseReturnHall?.addEventListener("click", () => requestReturnHall().catch((e) => console.error("错误位置: [pause return hall], 原因:", e)));
  } catch (error) {
    console.error("错误位置: [bind pause modal], 原因:", error);
  }

  try {
    dom.modeAAbort?.addEventListener("click", () => requestPause().catch((e) => console.error("错误位置: [abort A], 原因:", e)));
    dom.modeBAbort?.addEventListener("click", () => requestPause().catch((e) => console.error("错误位置: [abort B], 原因:", e)));
    dom.modeCAbort?.addEventListener("click", () => requestPause().catch((e) => console.error("错误位置: [abort C], 原因:", e)));
  } catch (error) {
    console.error("错误位置: [bind abort buttons], 原因:", error);
  }

  try {
    dom.modeAOptions?.querySelectorAll(".modal-option").forEach((btn) => {
      btn.addEventListener("click", () => submitModeA(btn.dataset.option).catch((e) => console.error("错误位置: [ModeA option], 原因:", e)));
    });
  } catch (error) {
    console.error("错误位置: [bind modeA options], 原因:", error);
  }

  try {
    dom.modeBOptions?.querySelectorAll(".modal-option").forEach((btn) => {
      btn.addEventListener("click", () => submitModeB(btn.dataset.option).catch((e) => console.error("错误位置: [ModeB option], 原因:", e)));
    });
    dom.modeBSpeakBox?.querySelectorAll(".modal-option").forEach((btn) => {
      btn.addEventListener("click", () => submitModeB_finishSpeak().catch((e) => console.error("错误位置: [ModeB finish speak], 原因:", e)));
    });
  } catch (error) {
    console.error("错误位置: [bind modeB options], 原因:", error);
  }

  try {
    dom.modeCOptions?.querySelectorAll(".modal-option").forEach((btn) => {
      btn.addEventListener("click", () => submitModeC_done().catch((e) => console.error("错误位置: [ModeC done], 原因:", e)));
    });
  } catch (error) {
    console.error("错误位置: [bind modeC options], 原因:", error);
  }
  
  try {
    dom.btnFinalNextRound?.addEventListener("click", () => {
      requestStartParty("A").catch(e => console.error("错误位置: [下一轮], 原因:", e));
   });
    dom.btnFinalReturnHall?.addEventListener("click", () => {
      requestReturnHall().catch(e => console.error("错误位置: [返回大厅], 原因:", e));
    });
  } catch (error) {
    console.error("错误位置: [bind final buttons], 原因:", error);
  }
}

async function initFirebase() {
  try {
    const config = getFirebaseConfig();
    if (!config) {
      console.error("找不到 Firebase 配置信息 (APP_CONFIG.firebase)");
      return false;
    }
    const app = initializeFirebaseApp(config);
    db = getDatabase(app);
    console.log("Firebase 初始化成功");
    return true;
  } catch (error) {
    console.error("错误位置: [initFirebase], 原因:", error);
    return false;
  }
}

async function main() {
  bindDom();
  bindDomEvents();

  if (dom.animalList) {
    dom.animalList.querySelectorAll(".animal-card").forEach((card) => {
      card.style.opacity = "0.3";
      card.style.filter = "grayscale(100%)";
      card.dataset.disabled = "true";
    });
  }
  
  if (dom.lobbyLoadingStatus) {
    dom.lobbyLoadingStatus.textContent = "正在连接大厅...";
    dom.lobbyLoadingStatus.style.display = "block";
  }

  refreshLobbyUI();

  const ok = await initFirebase(); 
  if (!ok) return;
  
  attachFirebaseListeners(); 
  refreshViewForJoinState();
  renderHallPlayers();
  refreshModeButtons();
  refreshAnimalSelectionUI();
  setInterval(() => tickUI(), 250);
  setInterval(() => gameLoopTick().catch((e) => console.error("错误位置: [gameLoopTick interval], 原因:", e)), 800);
}

document.addEventListener("DOMContentLoaded", () => {
  main().catch((error) => console.error("错误位置: [DOMContentLoaded main], 原因:", error));
});
