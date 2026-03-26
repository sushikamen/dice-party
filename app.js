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

console.log("app.js loaded");

let currentSelectedAnimalKey = null;
let pendingStartMode = null;
let lastRenderedRoundKey = "";
let db = null;
let geminiModel = null;

const ROOM_PATH = "partyRoom";
const GAMEMODE_DURATION_SECONDS = { A: 15, B: 15, C: 30 };

const ANIMAL_META = {
  dog: { label: "小狗", emoji: "🐶" },
  bear: { label: "小熊", emoji: "🐻" },
  rabbit: { label: "小兔", emoji: "🐰" },
  fox: { label: "狐狸", emoji: "🦊" }
};

const MODE_A_FALLBACK_POOL = [
  { question: "世界上最小的鸟是什么鸟？", options: { A: "麻雀", B: "蜂鸟", C: "燕子", D: "翠鸟" }, correct: "B", decode: "蜂鸟是世界上已知最小的鸟类，体重通常只有几克。" },
  { question: "澳大利亚的国宝动物中，哪一种的指纹与人类极度相似？", options: { A: "袋鼠", B: "考拉", C: "袋熊", D: "鸭嘴兽" }, correct: "B", decode: "考拉的指纹在电子扫描下与人类指纹极其相似，甚至曾在犯罪现场引起过混淆。" },
  { question: "著名动画《布鲁伊》(Bluey)中，布鲁伊是什么品种的狗？", options: { A: "柯基", B: "澳洲牧牛犬", C: "边境牧羊犬", D: "拉布拉多" }, correct: "B", decode: "布鲁伊是一只蓝色的澳洲牧牛犬（Blue Heeler）。" },
  { question: "水母大约有多少是由水组成的？", options: { A: "50%", B: "70%", C: "95%", D: "99%" }, correct: "C", decode: "水母的身体大约有95%是水，它们没有大脑、心脏和血液。" },
  { question: "八爪鱼（章鱼）有几颗心脏？", options: { A: "1颗", B: "2颗", C: "3颗", D: "4颗" }, correct: "C", decode: "章鱼有三颗心脏，其中两颗负责将血液泵入鳃，另一颗负责将血液输送到全身。" },
  { question: "人类的哪部分骨头最坚硬？", options: { A: "头骨", B: "大腿骨", C: "牙釉质", D: "肋骨" }, correct: "C", decode: "牙釉质是人体最坚硬的物质，含有高度钙化的矿物质。" },
  { question: "地球上最长的山脉是？", options: { A: "喜马拉雅山脉", B: "安第斯山脉", C: "落基山脉", D: "阿尔卑斯山脉" }, correct: "B", decode: "南美洲的安第斯山脉全长约7000公里，是陆地上最长的山脉。" },
  { question: "猫的味觉中缺少哪种味道的感知？", options: { A: "酸味", B: "甜味", C: "苦味", D: "咸味" }, correct: "B", decode: "由于基因突变，猫无法尝出甜味，所以它们对糖果没有兴趣。" },
  { question: "太阳系中唯一一颗自转方向与其他行星相反的行星是？", options: { A: "金星", B: "火星", C: "木星", D: "土星" }, correct: "A", decode: "金星的自转是自东向西的，所以在金星上太阳是西升东落的。" },
  { question: "大熊猫刚出生时大约有多重？", options: { A: "10-20克", B: "100-200克", C: "500-600克", D: "1-2千克" }, correct: "B", decode: "新生的大熊猫非常微小，通常体重只有100到200克左右。" },
  { question: "哪种血型被称为“万能受血者”？", options: { A: "A型", B: "B型", C: "O型", D: "AB型" }, correct: "D", decode: "AB型血的人体内没有抗A和抗B抗体，因此在紧急情况下可以接受任何血型的血液。" },
  { question: "人体最大的器官是？", options: { A: "肝脏", B: "大脑", C: "皮肤", D: "肺" }, correct: "C", decode: "皮肤是人体最大的器官，承担着保护身体、调节体温等重要功能。" },
  { question: "圆周率（π）的前三位数字是？", options: { A: "3.12", B: "3.14", C: "3.16", D: "3.18" }, correct: "B", decode: "圆周率是一个无理数，其前三位数字是3.14。" },
  { question: "哪种气体在地球大气层中占比最高？", options: { A: "氧气", B: "二氧化碳", C: "氮气", D: "氢气" }, correct: "C", decode: "地球大气中约78%是氮气，氧气仅占约21%。" },
  { question: "北极熊的皮肤实际上是什么颜色的？", options: { A: "白色", B: "粉色", C: "黑色", D: "透明" }, correct: "C", decode: "北极熊的毛是透明中空的，而它们的皮肤其实是黑色的，有助于吸收太阳光保暖。" }
];

function getNextFallbackQuestionA() {
  // 增加 ?. 可选链，确保在组件初始挂载且 gameState 未定义时不会抛出阻塞型异常
  const usedIndices = localState.gameState?.usedModeAIndices || [];
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

async function generateModeAQuestion(roundId, participantIds) {
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

async function applyModeAFallback(roundId, participantIds) {
  try {
    const { fallbackData, newUsedIndices } = getNextFallbackQuestionA();
    const startedAt = nowMs();
    const endsAt = startedAt + (GAMEMODE_DURATION_SECONDS.A || 15) * 1000;

    await update(roomRootRef(), {
      "gameState/usedModeAIndices": newUsedIndices,
      "gameState/round": {
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
      }
    });
  } catch (error) {
    console.error("错误位置: [applyModeAFallback], 原因:", error);
  }
}

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
  return Date.now();
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
    const mySubmitted = !!subs[myPlayerId];
    const canAnswer = stage === "a_answer" && participants.includes(myPlayerId) && !mySubmitted;

    dom.modeAResults.style.display = "none";
    dom.modeAWaiting.style.display = "none";
    dom.modeAOptions.style.display = "none";
    dom.modeADecode.textContent = round.decode || "";
    dom.modeAQuestion.textContent = round.question || "等待Bluey生成题目……";

    if (!stage || stage === "init") {
      dom.modeAWaiting.style.display = "block";
      dom.modeAWaiting.textContent = "等待Bluey生成题目……";
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
      dom.modeAWaiting.style.display = "none";
      dom.modeAOptions.style.display = "none";
      renderModeAOptions(round.options);
      renderModeAResults(round);
      return renderCountdown(round);
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
    dom.modeBResults.style.display = "none";
    dom.modeBWaiting.style.display = "none";
    dom.modeBOptions.style.display = "none";
    if (!stage || stage === "init") {
      dom.modeBWaiting.style.display = "block";
      dom.modeBWaiting.textContent = "等待Bluey生成吐槽问题……";
      return renderCountdown(round);
    }
    if (stage === "b_target_choice") {
      dom.modeBQuestion.textContent = round.question || "";
      const isTarget = myPlayerId === round.targetPlayerId;
      const mySubmitted = !!subs[myPlayerId];
      dom.modeBWaiting.style.display = "block";
      dom.modeBWaiting.textContent = isTarget ? "你正在选择真心话/谎话……" : "等待 Target 完成选择……";
      dom.modeBOptions.style.display = isTarget ? "flex" : "none";
      bindModeBOptionsEnabled(isTarget && !mySubmitted);
      return renderCountdown(round);
    }
    if (stage === "b_vote") {
      dom.modeBQuestion.textContent = "猜测：Target 选了真心话还是谎话？";
      const isTarget = myPlayerId === round.targetPlayerId;
      const mySubmitted = !!subs[myPlayerId];
      const canVote = !isTarget && participants.includes(myPlayerId) && !mySubmitted;
      dom.modeBWaiting.style.display = "block";
      dom.modeBWaiting.textContent = isTarget ? "Target 正在揭晓中……" : (mySubmitted ? "你已投票，等待揭晓……" : "现在请投票猜测！");
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
    const targetMeta = ANIMAL_META[localState.players[targetId]?.animalKey] || { label: "Target", emoji: "❓" };

    dom.modeBResultsList.innerHTML = "";
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

function renderModeC(round) {
  try {
    const stage = round.stage;
    const subs = getSubmissionsForRound();
    dom.modeCResults.style.display = "none";
    dom.modeCWaiting.style.display = "none";
    dom.modeCOptions.style.display = "none";
    if (!stage || stage === "init") {
      dom.modeCMission.textContent = "卧室大冒险";
      dom.modeCWaiting.style.display = "block";
      dom.modeCWaiting.textContent = "等待Bluey生成任务……";
      return renderCountdown(round);
    }
    if (stage === "c_mission") {
      dom.modeCMission.textContent = round.mission || "";
      dom.modeCWaiting.style.display = "block";
      dom.modeCWaiting.textContent = myPlayerId === round.targetPlayerId ? "Target：准备执行任务吧～" : "等待 Target 完成任务……";
      const mySubmitted = !!subs[myPlayerId];
      const canDone = myPlayerId === round.targetPlayerId && !mySubmitted;
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

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderModeCResults(round) {
  try {
    const results = round.results || {};
    const targetId = results.targetPlayerId;
    const doneByTarget = !!results.doneByTarget;
    const mission = round.mission || "";
    const participants = round.participantIds || [];

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
        item.innerHTML = `
          <div class="modal-results-item-left">
            <span class="modal-results-item-emoji" aria-hidden="true">${meta.emoji}</span><span>${meta.label}</span>
          </div>
          <div class="modal-results-item-right">观看中</div>
        `;
      } else {
        item.innerHTML = `
          <div class="modal-results-item-left">
            <span class="modal-results-item-emoji" aria-hidden="true">${meta.emoji}</span><span>${meta.label}</span>
          </div>
          <div class="modal-results-item-right">${doneByTarget ? "Target 已完成！" : "时间到，Target 未完成"}</div>
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
          const delta = Date.now() - (pause.appliedAtMs || Date.now());
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

    // ===== 核心修复：抢到锁后，绝对不要手动释放锁！让它自然过期，防止别的客户端重复触发 =====
    if (round.stage === "init") {
      if (await claimLock(`generate_${round.id}`, 15000)) {
        return await hostGenerateQuestionForRound(round);
      }
    }

    if (shouldRevealByTime(round)) {
      if (await claimLock(`reveal_${round.id}_${round.stage}`, 8000)) {
        return await hostRevealRound(round, getSubmissionsForRound());
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

    // 注意：这里使用了 / 符号而非 . 符号，这是 Firebase update 的正确路径语法
    await update(roomRootRef(), {
      "status": "playing",
      "submissions": null, 
      "locks": null,
      "gameState/mode": selectedMode,
      "gameState/pause": { active: false },
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

async function submitModeB(val) {
  const round = localState.gameState?.round;
  if (!round || round.subMode !== "B") return;
  if (isPauseActive()) return;
  try {
    const subs = getSubmissionsForRound();
    if (subs[myPlayerId]) return;
    if (round.stage === "b_target_choice") {
      if (round.targetPlayerId !== myPlayerId) return;
      await update(ref(db, `${ROOM_PATH}/submissions/${round.id}/${myPlayerId}`), { choice: val, submittedAt: serverTimestamp() });
      return;
    }
    if (round.stage === "b_vote") {
      if (round.targetPlayerId === myPlayerId) return;
      const participants = round.participantIds || [];
      if (!participants.includes(myPlayerId)) return;
      await update(ref(db, `${ROOM_PATH}/submissions/${round.id}/${myPlayerId}`), { guess: val, submittedAt: serverTimestamp() });
    }
  } catch (error) {
    console.error("错误位置: [submitModeB], 原因:", error);
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
  if (!ensureGeminiModel()) return applyModeBFallback(roundId, participantIds);
  try {
    const targetPlayerId = pickRandom(participantIds);
    const fallback = { question: "（备用）你有没有那种“别人看不出来但你自己很坚持”的小习惯？说出来我都替你尴尬一下。" };
    const prompt = `为 Mode B 生成一个针对 Target 的日常小癖好/轻微社死吐槽问题。只输出严格有效 JSON：{"question":"..."}。
Language: 简体中文；避免恋爱、男士、性或露骨内容；不要包含“真/假/Truth/Lie”等字眼。`;
    const result = await geminiModel.generateContent(prompt);
    const rawText = result?.response ? result.response.text() : "";
    const parsed = parseJsonSafely(rawText);
    const question = parsed?.question || fallback.question;

    const startedAt = nowMs();
    const endsAt = startedAt + (GAMEMODE_DURATION_SECONDS.B || 20) * 1000;
    await update(roomRootRef(), { "gameState/round": { ...localState.gameState.round, id: roundId, subMode: "B", stage: "b_target_choice", participantIds, targetPlayerId, question, targetChoice: null, startedAt, endsAt, autoNextAt: null, revealedAt: null, results: null } });
  } catch (error) {
    console.error("错误位置: [generateModeBQuestion], 原因:", error);
    await applyModeBFallback(roundId, participantIds);
  }
}

async function applyModeBFallback(roundId, participantIds) {
  try {
    const targetPlayerId = pickRandom(participantIds);
    const startedAt = nowMs();
    const endsAt = startedAt + (GAMEMODE_DURATION_SECONDS.B || 20) * 1000;
    await update(roomRootRef(), { "gameState/round": { ...localState.gameState.round, id: roundId, subMode: "B", stage: "b_target_choice", participantIds, targetPlayerId, question: "（备用）你有没有那种“别人看不出来但你自己很坚持”的小习惯？说出来我都替你尴尬一下。", targetChoice: null, startedAt, endsAt, autoNextAt: null, revealedAt: null, results: null } });
  } catch (error) {
    console.error("错误位置: [applyModeBFallback], 原因:", error);
  }
}

async function generateModeCQuestion(roundId, participantIds) {
  if (!ensureGeminiModel()) return applyModeCFallback(roundId, participantIds);
  try {
    const targetPlayerId = pickRandom(participantIds);
    const fallback = { mission: "（备用）用一张便利贴写一句“我今天要乖一点”，贴在桌角 10 秒，然后假装自己很认真。" };
    const prompt = `为 Mode C 生成一个适合在卧室/客厅用常见物品完成的搞笑小任务。只输出严格有效 JSON：{"mission":"..."}。
mission 简体中文，避免恋爱、男士、性或露骨内容。`;
    const result = await geminiModel.generateContent(prompt);
    const rawText = result?.response ? result.response.text() : "";
    const parsed = parseJsonSafely(rawText);
    const mission = parsed?.mission || fallback.mission;

    const startedAt = nowMs();
    const endsAt = startedAt + (GAMEMODE_DURATION_SECONDS.C || 30) * 1000;
    await update(roomRootRef(), { "gameState/round": { ...localState.gameState.round, id: roundId, subMode: "C", stage: "c_mission", participantIds, targetPlayerId, mission, startedAt, endsAt, autoNextAt: null, revealedAt: null, results: null } });
  } catch (error) {
    console.error("错误位置: [generateModeCQuestion], 原因:", error);
    await applyModeCFallback(roundId, participantIds);
  }
}

async function applyModeCFallback(roundId, participantIds) {
  try {
    const targetPlayerId = pickRandom(participantIds);
    const startedAt = nowMs();
    const endsAt = startedAt + (GAMEMODE_DURATION_SECONDS.C || 30) * 1000;
    await update(roomRootRef(), { "gameState/round": { ...localState.gameState.round, id: roundId, subMode: "C", stage: "c_mission", participantIds, targetPlayerId, mission: "（备用）用一张便利贴写一句“我今天要乖一点”，贴在桌角 10 秒，然后假装自己很认真。", startedAt, endsAt, autoNextAt: null, revealedAt: null, results: null } });
  } catch (error) {
    console.error("错误位置: [applyModeCFallback], 原因:", error);
  }
}

// ============================================================
// Reveal（host 写回 gameState）
// ============================================================
async function revealModeA(round, submissionsForRound) {
  try {
    const participantIds = round.participantIds || [];
    const results = {};
    participantIds.forEach((playerId) => {
      const sub = submissionsForRound[playerId] || {};
      const optionKey = sub.optionKey || null;
      // 🚨 只有当 optionKey 存在且等于正确答案时才是 true，其他情况全是 false
      const isCorrect = (optionKey && round.correct) ? (optionKey === round.correct) : false;
      results[playerId] = { optionKey, isCorrect };
    });
    const revealedAt = nowMs();
    await update(roomRootRef(), { 
      "gameState/round": { ...round, stage: "a_revealed", results, revealedAt, autoNextAt: revealedAt + 7000 } 
    });
  } catch (error) {
    console.error("错误位置: [revealModeA], 原因:", error);
  }
}

async function revealModeB_targetChoice(round, submissionsForRound) {
  try {
    const targetId = round.targetPlayerId;
    const targetSub = submissionsForRound[targetId] || {};
    const targetChoice = targetSub.choice || pickRandom(["truth", "lie"]);
    const revealedAt = nowMs();
    await update(roomRootRef(), { "gameState/round": { ...round, stage: "b_vote", targetChoice, endsAt: revealedAt + (GAMEMODE_DURATION_SECONDS.B || 20) * 1000, autoNextAt: null, results: null } });
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
let listenersAttached = false;
function attachFirebaseListeners() {
  if (listenersAttached || !db) return;
  listenersAttached = true;
  try {
    onValue(playersRef(), (snap) => {
      localState.players = snap.val() || {};
      refreshViewForJoinState();
      renderHallPlayers();
      refreshModeButtons();
      maybeRenderGame();
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
  } catch (error) {
    console.error("错误位置: [bind modeB options], 原因:", error);
  }

  try {
    dom.modeCOptions?.querySelectorAll(".modal-option").forEach(() => {
      // 仅一个按钮，data-option 可忽略
    });
    dom.modeCOptions?.querySelectorAll(".modal-option").forEach((btn) => {
      btn.addEventListener("click", () => submitModeC_done().catch((e) => console.error("错误位置: [ModeC done], 原因:", e)));
    });
  } catch (error) {
    console.error("错误位置: [bind modeC options], 原因:", error);
  }
}

async function main() {
  bindDom();
  bindDomEvents();
  refreshLobbyUI();

  const ok = await initFirebase();
  if (!ok) return;
  attachFirebaseListeners();
  refreshViewForJoinState();
  renderHallPlayers();
  refreshModeButtons();
  setInterval(() => tickUI(), 250);
  setInterval(() => gameLoopTick().catch((e) => console.error("错误位置: [gameLoopTick interval], 原因:", e)), 800);
}

document.addEventListener("DOMContentLoaded", () => {
  main().catch((error) => console.error("错误位置: [DOMContentLoaded main], 原因:", error));
});
