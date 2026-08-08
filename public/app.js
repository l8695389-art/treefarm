const MAX_ENERGY = 500;
const ENERGY_REGEN_MS = 2000;

const MINING_MAX_LEVEL = 20;
const MINING_BASE_XP = 500;
const MINING_XP_STEP = 300;
const MINING_XP_PER_TAP = 10;

const GEM_EXCHANGE_RATE = 100000;

const AD_ZONE_ID = "11524128";
const AD_ENERGY_REWARD = 20;
const AD_DAILY_LIMIT = 10;
const AD_COOLDOWN_SECONDS = 15 * 60;

const REFERRAL_MILESTONES = [
  { count: 5, coin: 5000, gem: 5 },
  { count: 10, coin: 12000, gem: 12 },
  { count: 20, coin: 30000, gem: 30 },
  { count: 50, coin: 100000, gem: 100 },
];

const MISSIONS = [
  { id: "tap50", label: "Chạm 50 lần hôm nay", reward: 100, check: (s) => s.dailyTaps >= 50 },
  { id: "coins1000", label: "Đạt 1.000 xu", reward: 200, check: (s) => s.coins >= 1000 },
  { id: "streak3", label: "Điểm danh 3 ngày liên tiếp", reward: 300, check: (s) => s.streak >= 3 },
];

function xpNeededForLevel(level) {
  return MINING_BASE_XP + MINING_XP_STEP * (level - 1);
}

function todayStr(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  const d1 = new Date(a + "T00:00:00Z").getTime();
  const d2 = new Date(b + "T00:00:00Z").getTime();
  return Math.round((d2 - d1) / 86400000);
}

// --- màn hình loading: thanh chạy tới ~90% trong lúc chờ API,
// nhảy lên 100% khi dữ liệu đã sẵn sàng rồi mới ẩn màn hình ---
const loadingFill = document.getElementById("loading-bar-fill");
const loadingPct = document.getElementById("loading-pct");
let loadingProgress = 0;
let loadingTickTimer = null;

function setLoadingProgress(pct) {
  loadingProgress = pct;
  loadingFill.style.width = pct + "%";
  loadingPct.textContent = Math.round(pct) + "%";
}

function startLoadingAnimation() {
  loadingTickTimer = setInterval(() => {
    if (loadingProgress >= 90) return;
    const step = Math.max(0.5, (90 - loadingProgress) / 12);
    setLoadingProgress(Math.min(90, loadingProgress + step));
  }, 90);
}

async function finishLoadingAnimation() {
  clearInterval(loadingTickTimer);
  setLoadingProgress(100);
  await new Promise((resolve) => setTimeout(resolve, 250));
  document.getElementById("loading").classList.add("hidden");
}

startLoadingAnimation();

// --- Telegram identity (falls back to a local id when opened outside Telegram) ---
const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;

const isLocalDev = ["localhost", "127.0.0.1"].includes(location.hostname);
const isTelegramLaunch = !!(tg && tg.initData && tg.initData.length > 0);

if (!isTelegramLaunch && !isLocalDev) {
  clearInterval(loadingTickTimer);
  document.getElementById("loading").classList.add("hidden");
  document.getElementById("blocked").classList.remove("hidden");
  throw new Error("Blocked: not opened inside Telegram");
}

if (tg) {
  tg.ready();
  tg.expand();
}
const tgUser = tg && tg.initDataUnsafe ? tg.initDataUnsafe.user : null;
const initData = tg ? tg.initData : "";

// Link mời bạn: mở qua t.me/<bot>/<app>?startapp=ref_<uid> sẽ khiến Telegram
// truyền lại giá trị này qua initDataUnsafe.start_param khi người được mời
// mở Mini App lần đầu.
const startParam = tg && tg.initDataUnsafe ? tg.initDataUnsafe.start_param : "";
const REFERRED_BY_FROM_LINK = startParam && startParam.startsWith("ref_") ? startParam.slice(4) : null;

function getLocalId() {
  let id = localStorage.getItem("crystal_local_id");
  if (!id) {
    id = "local-" + crypto.randomUUID();
    localStorage.setItem("crystal_local_id", id);
  }
  return id;
}
const PLAYER_ID = tgUser ? String(tgUser.id) : getLocalId();

function resolveTelegramNickname(user) {
  if (!user) return "";
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  if (displayName) return displayName;
  if (user.username) return "@" + user.username;
  return "";
}
const TELEGRAM_NICKNAME = resolveTelegramNickname(tgUser);
const TELEGRAM_AVATAR_URL = tgUser && tgUser.photo_url ? tgUser.photo_url : "";
const TELEGRAM_USERNAME = tgUser && tgUser.username ? tgUser.username : "";

function defaultState() {
  return {
    id: PLAYER_ID,
    nickname: TELEGRAM_NICKNAME,
    username: TELEGRAM_USERNAME,
    avatarUrl: TELEGRAM_AVATAR_URL,
    coins: 0,
    gems: 0,
    energy: MAX_ENERGY,
    lastEnergyTs: Date.now(),
    streak: 0,
    lastCheckin: null,
    totalTaps: 0,
    dailyTaps: 0,
    dailyTapsDate: todayStr(),
    claimedMissions: [],
    miningLevel: 1,
    miningXp: 0,
    referredBy: null,
    referralCount: 0,
    referralEarnings: 0,
    claimedReferralMilestones: [],
    referredUsers: [],
    gemExchangeLog: [],
    adViewsToday: 0,
    adLastViewTs: 0,
  };
}

let state = null;
let saveTimer = null;
let botConfig = { botUsername: "", appShortName: "" };

// --- API ---
async function apiGetPlayer(id) {
  const res = await fetch(`/api/player?id=${encodeURIComponent(id)}`);
  const data = await res.json();
  return data.player;
}
async function apiSavePlayer(player) {
  await fetch("/api/player", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ player, initData, referredBy: REFERRED_BY_FROM_LINK }),
  });
}
async function apiGetLeaderboard() {
  const res = await fetch("/api/leaderboard");
  const data = await res.json();
  return data.leaderboard || [];
}
async function apiGetConfig() {
  try {
    const res = await fetch("/api/config");
    return await res.json();
  } catch {
    return { botUsername: "", appShortName: "" };
  }
}
async function apiExchangeGem(coinAmount) {
  const res = await fetch("/api/gem-exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid: PLAYER_ID, coinAmount, initData }),
  });
  return res.json();
}
async function apiClaimReferralMilestone(milestone) {
  const res = await fetch("/api/referral/claim-milestone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid: PLAYER_ID, milestone, initData }),
  });
  return res.json();
}
async function apiWatchAd() {
  const res = await fetch("/api/watch-ad", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid: PLAYER_ID, initData }),
  });
  return res.json();
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => apiSavePlayer(state).catch(() => {}), 500);
}

// --- init ---
(async function init() {
  let player = null;
  try {
    player = await apiGetPlayer(PLAYER_ID);
  } catch {
    player = null;
  }

  if (player) {
    state = player;
    if (state.dailyTapsDate !== todayStr()) {
      state.dailyTaps = 0;
      state.dailyTapsDate = todayStr();
    }
    if (TELEGRAM_NICKNAME) state.nickname = TELEGRAM_NICKNAME;
    if (TELEGRAM_AVATAR_URL) state.avatarUrl = TELEGRAM_AVATAR_URL;
    if (TELEGRAM_USERNAME) state.username = TELEGRAM_USERNAME;
  } else {
    state = defaultState();
  }

  botConfig = await apiGetConfig();

  await finishLoadingAnimation();

  if (!state.nickname) {
    document.getElementById("welcome").classList.remove("hidden");
  } else {
    scheduleSave();
    showGame();
  }
})();

document.getElementById("start-btn").addEventListener("click", () => {
  const name = document.getElementById("nickname-input").value.trim().slice(0, 16);
  if (!name) return;
  state.nickname = name;
  document.getElementById("welcome").classList.add("hidden");
  scheduleSave();
  showGame();
});

function showGame() {
  document.getElementById("phone").classList.remove("hidden");
  render();
  renderReferralLink();
  setInterval(energyTick, ENERGY_REGEN_MS);
  refreshLeaderboard();
}

function energyTick() {
  if (state.energy >= MAX_ENERGY) return;
  state.energy = Math.min(MAX_ENERGY, state.energy + 1);
  state.lastEnergyTs = Date.now();
  renderBars();
  scheduleSave();
}

// --- render ---
function renderAvatar(containerEl, nickname, avatarUrl) {
  containerEl.innerHTML = "";
  if (avatarUrl) {
    const img = document.createElement("img");
    img.src = avatarUrl;
    img.alt = nickname;
    img.style.cssText = "width:100%;height:100%;object-fit:cover;border-radius:inherit;";
    img.onerror = () => {
      containerEl.innerHTML = "";
      containerEl.textContent = nickname.slice(0, 1).toUpperCase();
    };
    containerEl.appendChild(img);
  } else {
    containerEl.textContent = nickname.slice(0, 1).toUpperCase();
  }
}

function render() {
  renderAvatar(document.getElementById("avatar-letter"), state.nickname, state.avatarUrl);
  document.getElementById("nick-text").textContent = state.nickname;
  document.getElementById("taps-text").textContent = `${state.totalTaps.toLocaleString()} lần chạm`;
  document.getElementById("coin-text").textContent = state.coins.toLocaleString();
  document.getElementById("gem-text").textContent = state.gems.toLocaleString();
  document.getElementById("level-text").textContent = `Cấp ${state.miningLevel}`;
  renderBars();
  renderCheckin();
  renderWatchAdButton();
  renderMissions();
  renderShop();
  renderFriends();
  renderWallet();
}

function renderBars() {
  const energyPct = Math.round((state.energy / MAX_ENERGY) * 100);
  document.getElementById("energy-fill").style.width = energyPct + "%";
  document.getElementById("energy-text").textContent = `${state.energy}/${MAX_ENERGY}`;

  const maxed = state.miningLevel >= MINING_MAX_LEVEL;
  const needed = xpNeededForLevel(state.miningLevel);
  const xpPct = maxed ? 100 : Math.round((state.miningXp / needed) * 100);
  document.getElementById("xp-fill").style.width = xpPct + "%";
  document.getElementById("xp-text").textContent = maxed ? "MAX" : `${state.miningXp}/${needed}`;
  document.getElementById("level-text").textContent = `Cấp ${state.miningLevel}${maxed ? " (Max)" : ""}`;
}

function renderCheckin() {
  const btn = document.getElementById("checkin-btn");
  const label = document.getElementById("checkin-label");
  const checkedInToday = state.lastCheckin === todayStr();
  btn.disabled = checkedInToday;
  label.textContent = checkedInToday
    ? `Đã điểm danh · Chuỗi ${state.streak} ngày`
    : `Điểm danh · Chuỗi ${state.streak} ngày`;
}

// --- Xem quảng cáo nhận thưởng năng lượng ---
let adCooldownTimer = null;

function formatCooldown(totalSeconds) {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function renderWatchAdButton() {
  const btn = document.getElementById("watch-ad-btn");
  const label = document.getElementById("watch-ad-label");
  const errorEl = document.getElementById("watch-ad-error");

  if (state.adViewsToday >= AD_DAILY_LIMIT) {
    clearInterval(adCooldownTimer);
    btn.disabled = true;
    label.textContent = `✅ Đã hết lượt hôm nay · ${AD_DAILY_LIMIT}/${AD_DAILY_LIMIT}`;
    return;
  }

  const elapsedSinceLast = Date.now() - (state.adLastViewTs || 0);
  const remaining = AD_COOLDOWN_SECONDS - Math.floor(elapsedSinceLast / 1000);

  if (state.adLastViewTs && remaining > 0) {
    btn.disabled = true;
    startAdCooldownCountdown(remaining);
  } else {
    clearInterval(adCooldownTimer);
    btn.disabled = false;
    label.textContent = `Xem quảng cáo (+${AD_ENERGY_REWARD} năng lượng) · ${state.adViewsToday}/${AD_DAILY_LIMIT}`;
  }
  errorEl.style.display = "none";
}

function startAdCooldownCountdown(seconds) {
  const btn = document.getElementById("watch-ad-btn");
  const label = document.getElementById("watch-ad-label");
  clearInterval(adCooldownTimer);
  let remaining = seconds;
  const tick = () => {
    if (remaining <= 0) {
      clearInterval(adCooldownTimer);
      btn.disabled = false;
      label.textContent = `Xem quảng cáo (+${AD_ENERGY_REWARD} năng lượng) · ${state.adViewsToday}/${AD_DAILY_LIMIT}`;
      return;
    }
    btn.disabled = true;
    label.textContent = `Chờ ${formatCooldown(remaining)} để xem tiếp`;
    remaining -= 1;
  };
  tick();
  adCooldownTimer = setInterval(tick, 1000);
}

document.getElementById("watch-ad-btn").addEventListener("click", () => {
  const btn = document.getElementById("watch-ad-btn");
  const label = document.getElementById("watch-ad-label");
  const errorEl = document.getElementById("watch-ad-error");
  errorEl.style.display = "none";

  const showAdFn = window["show_" + AD_ZONE_ID];
  if (typeof showAdFn !== "function") {
    errorEl.textContent = "Không tải được quảng cáo, thử lại sau.";
    errorEl.style.display = "block";
    return;
  }

  btn.disabled = true;
  btn.classList.add("loading");
  const oldLabel = label.textContent;
  label.textContent = "Đang tải quảng cáo...";

  showAdFn()
    .then(async () => {
      btn.classList.remove("loading");
      try {
        const result = await apiWatchAd();
        if (result.ok) {
          state.energy = result.energy;
          state.adViewsToday = result.adViewsToday;
          state.adLastViewTs = Date.now();
          renderBars();
          renderWatchAdButton();
          showToast(`🎬 +${AD_ENERGY_REWARD} năng lượng!`);
        } else if (result.error === "limit_reached") {
          state.adViewsToday = result.adViewsToday ?? AD_DAILY_LIMIT;
          renderWatchAdButton();
        } else if (result.error === "cooldown") {
          state.adLastViewTs = Date.now() - (AD_COOLDOWN_SECONDS - result.remainingSeconds) * 1000;
          startAdCooldownCountdown(result.remainingSeconds);
        } else {
          btn.disabled = false;
          label.textContent = oldLabel;
          errorEl.textContent = "Không nhận được thưởng, thử lại sau.";
          errorEl.style.display = "block";
        }
      } catch {
        btn.disabled = false;
        label.textContent = oldLabel;
        errorEl.textContent = "Lỗi kết nối, thử lại sau.";
        errorEl.style.display = "block";
      }
    })
    .catch(() => {
      btn.disabled = false;
      btn.classList.remove("loading");
      label.textContent = oldLabel;
      errorEl.textContent = "Quảng cáo chưa tải xong hoặc bị chặn, thử lại sau.";
      errorEl.style.display = "block";
    });
});

function renderMissions() {
  const list = document.getElementById("missions-list");
  list.innerHTML = "";
  for (const m of MISSIONS) {
    const done = m.check(state);
    const claimed = state.claimedMissions.includes(m.id);
    const row = document.createElement("div");
    row.className = "mission-row";
    row.innerHTML = `
      <div>
        <div class="mission-label">${m.label}</div>
        <div class="sub-text">Thưởng ${m.reward} xu</div>
      </div>
      ${
        claimed
          ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3ED8C3" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`
          : `<button class="claim-btn" ${done ? "" : "disabled"} data-mission="${m.id}">Nhận</button>`
      }
    `;
    list.appendChild(row);
  }
  list.querySelectorAll(".claim-btn").forEach((btn) => {
    btn.addEventListener("click", () => claimMission(btn.dataset.mission));
  });
}

// --- Shop (đổi gem) ---
function renderShop() {
  document.getElementById("shop-coin-balance").textContent = state.coins.toLocaleString();
  document.getElementById("shop-gem-balance").textContent = state.gems.toLocaleString();
  updateExchangePreview();
}

function updateExchangePreview() {
  const input = document.getElementById("exchange-input");
  const amount = Number(input.value) || 0;
  const gems = amount > 0 ? Math.floor(amount / GEM_EXCHANGE_RATE) : 0;
  document.getElementById("exchange-preview-gem").textContent = `${gems.toLocaleString()} gem`;
}

document.getElementById("exchange-input").addEventListener("input", updateExchangePreview);

document.querySelectorAll(".quick-amount-btn[data-amount]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.getElementById("exchange-input").value = btn.dataset.amount;
    updateExchangePreview();
  });
});

document.getElementById("quick-amount-max").addEventListener("click", () => {
  const maxMultiple = Math.floor(state.coins / GEM_EXCHANGE_RATE) * GEM_EXCHANGE_RATE;
  document.getElementById("exchange-input").value = maxMultiple || 0;
  updateExchangePreview();
});

document.getElementById("exchange-btn").addEventListener("click", async () => {
  const errorEl = document.getElementById("exchange-error");
  const successEl = document.getElementById("exchange-success");
  errorEl.style.display = "none";
  successEl.style.display = "none";

  const input = document.getElementById("exchange-input");
  const amount = Number(input.value);

  if (!amount || amount <= 0) {
    errorEl.textContent = "Vui lòng nhập số coin muốn đổi.";
    errorEl.style.display = "block";
    return;
  }
  if (amount % GEM_EXCHANGE_RATE !== 0) {
    errorEl.textContent = `Số coin phải là bội số của ${GEM_EXCHANGE_RATE.toLocaleString()}.`;
    errorEl.style.display = "block";
    return;
  }
  if (amount > state.coins) {
    errorEl.textContent = "Bạn không đủ coin để đổi số lượng này.";
    errorEl.style.display = "block";
    return;
  }

  const btn = document.getElementById("exchange-btn");
  btn.disabled = true;
  btn.textContent = "Đang xử lý...";

  try {
    const result = await apiExchangeGem(amount);
    btn.disabled = false;
    btn.textContent = "Đổi ngay";

    if (result.ok) {
      state.coins = result.coins;
      state.gems = result.gems;
      state.gemExchangeLog = result.gemExchangeLog;
      input.value = "";
      updateExchangePreview();
      successEl.textContent = `Đã đổi thành công! +${(amount / GEM_EXCHANGE_RATE).toLocaleString()} gem`;
      successEl.style.display = "block";
      render();
    } else {
      const messages = {
        invalid_amount: `Số coin phải là bội số của ${GEM_EXCHANGE_RATE.toLocaleString()}.`,
        insufficient_coins: "Bạn không đủ coin để đổi.",
        unauthorized: "Không xác thực được, thử mở lại app.",
      };
      errorEl.textContent = messages[result.error] || "Không đổi được, thử lại sau.";
      errorEl.style.display = "block";
    }
  } catch {
    btn.disabled = false;
    btn.textContent = "Đổi ngay";
    errorEl.textContent = "Lỗi kết nối, thử lại sau.";
    errorEl.style.display = "block";
  }
});

// --- Friends (mời bạn) ---
function buildReferralLink() {
  if (botConfig.botUsername && botConfig.appShortName) {
    return `https://t.me/${botConfig.botUsername}/${botConfig.appShortName}?startapp=ref_${PLAYER_ID}`;
  }
  return "";
}

function renderReferralLink() {
  const link = buildReferralLink();
  const el = document.getElementById("ref-link-text");
  el.textContent = link || "Chưa cấu hình BOT_USERNAME / APP_SHORT_NAME trên Worker";
  document.getElementById("ref-copy-btn").dataset.link = link;
}

document.getElementById("ref-copy-btn").addEventListener("click", async (e) => {
  const link = e.currentTarget.dataset.link;
  if (!link) return;
  await navigator.clipboard.writeText(link).catch(() => {});
  const btn = e.currentTarget;
  const old = btn.textContent;
  btn.textContent = "Đã chép ✓";
  setTimeout(() => (btn.textContent = old), 1500);
});

function renderFriends() {
  document.getElementById("friend-count").textContent = state.referralCount.toLocaleString();
  document.getElementById("friend-earnings").textContent = state.referralEarnings.toLocaleString();

  const milestoneList = document.getElementById("milestone-list");
  milestoneList.innerHTML = "";
  for (const m of REFERRAL_MILESTONES) {
    const reached = state.referralCount >= m.count;
    const claimed = state.claimedReferralMilestones.includes(m.count);
    const row = document.createElement("div");
    row.className = "milestone-row";
    row.innerHTML = `
      <div class="milestone-icon ${reached ? "done" : ""}">${m.count}</div>
      <div class="milestone-info">
        <div class="milestone-title">Mời ${m.count} bạn</div>
        <div class="milestone-sub">Thưởng ${m.coin.toLocaleString()} coin + ${m.gem} gem</div>
      </div>
      ${
        claimed
          ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3ED8C3" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`
          : `<button class="claim-btn" ${reached ? "" : "disabled"} data-milestone="${m.count}">Nhận</button>`
      }
    `;
    milestoneList.appendChild(row);
  }
  milestoneList.querySelectorAll(".claim-btn").forEach((btn) => {
    btn.addEventListener("click", () => claimReferralMilestone(Number(btn.dataset.milestone)));
  });

  const friendList = document.getElementById("friend-list");
  if (!state.referredUsers || !state.referredUsers.length) {
    friendList.innerHTML = `<div class="sub-text">Chưa mời được người bạn nào.</div>`;
  } else {
    friendList.innerHTML = state.referredUsers
      .slice(0, 30)
      .map(
        (u) => `
        <div class="lb-row">
          <span class="lb-name">${escapeHtml(u.nickname || "Người chơi")}</span>
          <span class="sub-text">${new Date(u.ts).toLocaleDateString("vi-VN")}</span>
        </div>`
      )
      .join("");
  }
}

async function claimReferralMilestone(milestone) {
  try {
    const result = await apiClaimReferralMilestone(milestone);
    if (result.ok) {
      state.coins = result.coins;
      state.gems = result.gems;
      state.claimedReferralMilestones = result.claimedReferralMilestones;
      showToast(`Nhận +${result.reward.coin.toLocaleString()} coin, +${result.reward.gem} gem`);
      render();
    } else {
      showToast("Chưa thể nhận thưởng mốc này.");
    }
  } catch {
    showToast("Lỗi kết nối, thử lại sau.");
  }
}

// --- Wallet ---
function renderWallet() {
  document.getElementById("wallet-coin").textContent = state.coins.toLocaleString();
  document.getElementById("wallet-gem").textContent = state.gems.toLocaleString();
  document.getElementById("wallet-taps").textContent = state.totalTaps.toLocaleString();
  document.getElementById("wallet-streak").textContent = state.streak.toLocaleString();
  document.getElementById("wallet-friends").textContent = state.referralCount.toLocaleString();
  document.getElementById("wallet-commission").textContent = state.referralEarnings.toLocaleString();

  const historyEl = document.getElementById("wallet-history");
  if (!state.gemExchangeLog || !state.gemExchangeLog.length) {
    historyEl.innerHTML = `<div class="sub-text">Chưa có lượt đổi gem nào.</div>`;
  } else {
    historyEl.innerHTML = state.gemExchangeLog
      .map(
        (h) => `
        <div class="history-row">
          <span class="history-coin">-${h.coin.toLocaleString()} coin</span>
          <span class="history-gem">+${h.gem.toLocaleString()} gem</span>
          <span class="history-time">${new Date(h.ts).toLocaleDateString("vi-VN")}</span>
        </div>`
      )
      .join("");
  }
}

// --- leaderboard ---
async function renderLeaderboard(rows) {
  const list = document.getElementById("leaderboard-list");
  if (!rows.length) {
    list.innerHTML = `<div class="sub-text">Chưa có dữ liệu.</div>`;
    return;
  }
  list.innerHTML = rows
    .map((row, i) => {
      const avatar = row.avatar_url
        ? `<img src="${escapeHtml(row.avatar_url)}" alt="" style="width:28px;height:28px;border-radius:8px;object-fit:cover;" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'lb-avatar-fallback',textContent:'${escapeHtml(row.nickname.slice(0, 1).toUpperCase())}'}))" />`
        : `<div class="lb-avatar-fallback">${escapeHtml(row.nickname.slice(0, 1).toUpperCase())}</div>`;
      return `
      <div class="lb-row">
        <span class="lb-rank">${i + 1}</span>
        ${avatar}
        <span class="lb-name">${escapeHtml(row.nickname)}</span>
        <span class="lb-coins">${row.coins.toLocaleString()} xu</span>
      </div>`;
    })
    .join("");
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

async function refreshLeaderboard() {
  try {
    const rows = await apiGetLeaderboard();
    renderLeaderboard(rows);
  } catch {}
}

// --- toast ---
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

// --- game actions ---
document.getElementById("crystal-wrap").addEventListener("click", (e) => {
  if (state.energy <= 0) return;

  const crit = Math.random() < 0.1;
  const base = crit ? 6 : 1;
  const levelBonus = 1 + (state.miningLevel - 1) * 0.05;
  const gain = Math.max(1, Math.round(base * levelBonus));
  const isNewDay = state.dailyTapsDate !== todayStr();

  state.coins += gain;
  state.energy -= 1;
  state.totalTaps += 1;
  state.dailyTaps = isNewDay ? 1 : state.dailyTaps + 1;
  state.dailyTapsDate = todayStr();
  state.lastEnergyTs = Date.now();

  // XP + lên cấp đào
  let leveledUp = false;
  if (state.miningLevel < MINING_MAX_LEVEL) {
    state.miningXp += MINING_XP_PER_TAP;
    while (state.miningLevel < MINING_MAX_LEVEL) {
      const needed = xpNeededForLevel(state.miningLevel);
      if (state.miningXp < needed) break;
      state.miningXp -= needed;
      state.miningLevel += 1;
      leveledUp = true;
    }
    if (state.miningLevel >= MINING_MAX_LEVEL) state.miningXp = 0;
  }

  document.getElementById("coin-text").textContent = state.coins.toLocaleString();
  document.getElementById("taps-text").textContent = `${state.totalTaps.toLocaleString()} lần chạm`;
  renderBars();
  renderMissions();

  if (leveledUp) showToast(`🎉 Lên cấp ${state.miningLevel}!`);

  const glow = document.getElementById("glow");
  const btn = document.getElementById("crystal-btn");
  glow.classList.add("pulse");
  btn.classList.add("pulse");
  setTimeout(() => {
    glow.classList.remove("pulse");
    btn.classList.remove("pulse");
  }, 120);

  const rect = e.currentTarget.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const p = document.createElement("span");
  p.className = "particle";
  p.style.left = x + "px";
  p.style.top = y + "px";
  p.textContent = "+" + gain;
  e.currentTarget.appendChild(p);
  setTimeout(() => p.remove(), 700);

  scheduleSave();
});

document.getElementById("checkin-btn").addEventListener("click", () => {
  const today = todayStr();
  if (state.lastCheckin === today) return;
  let newStreak = 1;
  if (state.lastCheckin) {
    const gap = daysBetween(state.lastCheckin, today);
    newStreak = gap === 1 ? state.streak + 1 : 1;
  }
  const reward = 50 * Math.min(newStreak, 10);
  state.streak = newStreak;
  state.lastCheckin = today;
  state.coins += reward;
  showToast(`+${reward} xu · Chuỗi ${newStreak} ngày`);
  render();
  scheduleSave();
});

function claimMission(id) {
  const m = MISSIONS.find((x) => x.id === id);
  if (!m || state.claimedMissions.includes(id) || !m.check(state)) return;
  state.coins += m.reward;
  state.claimedMissions.push(id);
  showToast(`Nhận +${m.reward} xu`);
  render();
  scheduleSave();
}

// --- tabs ---
const TAB_IDS = ["play", "shop", "leaderboard", "friends", "missions", "wallet"];
document.querySelectorAll(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    TAB_IDS.forEach((id) => document.getElementById("tab-" + id).classList.add("hidden"));
    document.getElementById("tab-" + btn.dataset.tab).classList.remove("hidden");
    if (btn.dataset.tab === "leaderboard") refreshLeaderboard();
    if (btn.dataset.tab === "shop") renderShop();
    if (btn.dataset.tab === "friends") renderFriends();
    if (btn.dataset.tab === "wallet") renderWallet();
  });
});

// save on page hide
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && state) {
    apiSavePlayer(state).catch(() => {});
  }
});
