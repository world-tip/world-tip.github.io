import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { collection, doc, getDocs, getFirestore, setDoc } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const FIXTURE_URL = "data/fixtures.json";
const CURRENT_PROFILE_KEY = "worldCupTippingProfileId.v1";

const firebaseConfig = {
  apiKey: "AIzaSyBVJkCwnVe80fqqCAsT4YsUG-JRIE-gG4I",
  authDomain: "world-tip-4a2c3.firebaseapp.com",
  projectId: "world-tip-4a2c3",
  storageBucket: "world-tip-4a2c3.firebasestorage.app",
  messagingSenderId: "862737079191",
  appId: "1:862737079191:web:ce598ae571a5ca559ac2d2",
  measurementId: "G-NK1CXS6P9E"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

const TEAM_FLAGS_BY_CODE = {
  ARG: "🇦🇷",
  AUS: "🇦🇺",
  BIH: "🇧🇦",
  BRA: "🇧🇷",
  CAN: "🇨🇦",
  CIV: "🇨🇮",
  GER: "🇩🇪",
  JPN: "🇯🇵",
  MAR: "🇲🇦",
  MEX: "🇲🇽",
  NED: "🇳🇱",
  RSA: "🇿🇦",
  SUI: "🇨🇭",
  USA: "🇺🇸"
};

const state = {
  fixtures: [],
  profiles: [],
  tips: {},
  currentProfileId: localStorage.getItem(CURRENT_PROFILE_KEY) || "",
  draftTips: {}
};

const els = {
  tabs: document.querySelectorAll(".tab"),
  views: document.querySelectorAll(".view"),
  tipsList: document.querySelector("#tipsList"),
  matchesList: document.querySelector("#matchesList"),
  ladderRows: document.querySelector("#ladderRows"),
  saveTipsButton: document.querySelector("#saveTipsButton"),
  profileStatus: document.querySelector("#profileStatus"),
  currentProfileName: document.querySelector("#currentProfileName"),
  nextLockout: document.querySelector("#nextLockout"),
  matchCount: document.querySelector("#matchCount"),
  switchProfileButton: document.querySelector("#switchProfileButton"),
  createProfileForm: document.querySelector("#createProfileForm"),
  loginProfileForm: document.querySelector("#loginProfileForm"),
  profileSelect: document.querySelector("#profileSelect"),
  toast: document.querySelector("#toast")
};

const storageAdapter = {
  async load() {
    const [profilesSnapshot, tipsSnapshot] = await Promise.all([
      getDocs(collection(db, "profiles")),
      getDocs(collection(db, "tips"))
    ]);

    const profiles = profilesSnapshot.docs
      .map((profileDoc) => ({ id: profileDoc.id, ...profileDoc.data() }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const tips = {};
    tipsSnapshot.docs.forEach((tipsDoc) => {
      const data = tipsDoc.data();
      tips[tipsDoc.id] = data.picks || {};
    });

    return { profiles, tips };
  },

  async save(nextState) {
    const profileWrites = nextState.profiles.map((profile) => setDoc(doc(db, "profiles", profile.id), {
      name: profile.name,
      pin: profile.pin,
      createdAt: profile.createdAt
    }, { merge: true }));

    const tipWrites = Object.entries(nextState.tips).map(([profileId, picks]) => setDoc(doc(db, "tips", profileId), {
      profileId,
      picks,
      updatedAt: new Date().toISOString()
    }, { merge: true }));

    await Promise.all([...profileWrites, ...tipWrites]);
  }
};

init();

async function init() {
  await loadFixtures();

  try {
    const saved = await storageAdapter.load();
    state.profiles = saved.profiles || [];
    state.tips = saved.tips || {};
  } catch (error) {
    console.error(error);
    showToast("Could not load Firebase data. Check Firestore setup.");
  }

  state.draftTips = { ...(state.tips[state.currentProfileId] || {}) };
  bindEvents();
  render();
}

async function loadFixtures() {
  try {
    const response = await fetch(FIXTURE_URL, { cache: "no-store" });
    const data = await response.json();
    state.fixtures = data.matches || [];
  } catch (error) {
    state.fixtures = [];
    showToast("Could not load fixtures.json");
  }
}

function bindEvents() {
  els.tabs.forEach((tab) => {
    tab.addEventListener("click", () => setView(tab.dataset.view));
  });

  els.saveTipsButton.addEventListener("click", saveCurrentTips);
  els.switchProfileButton.addEventListener("click", () => setView("profile"));
  els.createProfileForm.addEventListener("submit", createProfile);
  els.loginProfileForm.addEventListener("submit", loginProfile);
}

function setView(viewName) {
  els.tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.view === viewName));
  els.views.forEach((view) => view.classList.toggle("active", view.id === `${viewName}View`));
}

function render() {
  const profile = getCurrentProfile();
  state.draftTips = { ...(state.tips[state.currentProfileId] || {}), ...state.draftTips };

  els.profileStatus.textContent = profile ? profile.name : "No profile";
  els.currentProfileName.textContent = profile ? profile.name : "Create or login";
  els.matchCount.textContent = String(state.fixtures.length);
  els.nextLockout.textContent = getNextLockoutText();

  renderProfileSelect();
  renderTips();
  renderMatches();
  renderLadder();
}

function renderTips() {
  if (!state.fixtures.length) {
    els.tipsList.innerHTML = emptyState("No fixtures loaded yet.");
    return;
  }

  els.tipsList.innerHTML = state.fixtures.map((match) => {
    const locked = isLocked(match);
    const selected = state.draftTips[match.id] || "";
    const status = locked ? "Locked" : `Locks ${formatTime(match.lockAtUtc)}`;
    const disabled = locked || !getCurrentProfile() ? "disabled" : "";

    return `
      <article class="match-card">
        <div class="match-meta">
          <span>${escapeHtml(match.stage)} - ${formatDate(match.kickoffUtc)}</span>
          <span class="lock-badge ${locked ? "locked" : ""}">${status}</span>
        </div>
        ${teamMarkup(match.homeTeam, match.score?.home)}
        ${teamMarkup(match.awayTeam, match.score?.away)}
        <div class="pick-columns" role="group" aria-label="Pick winner for ${escapeHtml(match.homeTeam.name)} versus ${escapeHtml(match.awayTeam.name)}">
          <button class="tip-choice ${selected === match.homeTeam.id ? "selected" : ""}" data-match-id="${match.id}" data-team-id="${match.homeTeam.id}" ${disabled} type="button">
            ${escapeHtml(match.homeTeam.shortName)}
          </button>
          <button class="tip-choice ${selected === match.awayTeam.id ? "selected" : ""}" data-match-id="${match.id}" data-team-id="${match.awayTeam.id}" ${disabled} type="button">
            ${escapeHtml(match.awayTeam.shortName)}
          </button>
        </div>
      </article>
    `;
  }).join("");

  els.tipsList.querySelectorAll(".tip-choice").forEach((button) => {
    button.addEventListener("click", () => {
      state.draftTips[button.dataset.matchId] = button.dataset.teamId;
      renderTips();
    });
  });
}

function renderMatches() {
  if (!state.fixtures.length) {
    els.matchesList.innerHTML = emptyState("No fixtures loaded yet.");
    return;
  }

  els.matchesList.innerHTML = state.fixtures.map((match) => {
    const locked = isLocked(match);
    const homePickers = getPickers(match.id, match.homeTeam.id);
    const awayPickers = getPickers(match.id, match.awayTeam.id);

    return `
      <article class="match-card">
        <div class="match-meta">
          <span>${escapeHtml(match.stage)} - ${formatDate(match.kickoffUtc)}</span>
          <span class="lock-badge ${locked ? "locked" : ""}">${locked ? "Picks visible" : `Hidden until ${formatTime(match.lockAtUtc)}`}</span>
        </div>
        ${teamMarkup(match.homeTeam, match.score?.home)}
        ${teamMarkup(match.awayTeam, match.score?.away)}
        ${locked ? `
          <div class="pick-columns">
            ${pickColumn(match.homeTeam.shortName, homePickers)}
            ${pickColumn(match.awayTeam.shortName, awayPickers)}
          </div>
        ` : `<p class="hidden-picks">Picks are hidden until lockout.</p>`}
      </article>
    `;
  }).join("");
}

function renderLadder() {
  const rows = state.profiles
    .map((profile) => ({
      profile,
      correct: countCorrect(profile.id),
      pending: countPending(profile.id)
    }))
    .sort((a, b) => b.correct - a.correct || a.pending - b.pending || a.profile.name.localeCompare(b.profile.name));

  els.ladderRows.innerHTML = rows.length
    ? rows.map((row, index) => `
      <div class="ladder-row">
        <span>${index + 1}</span>
        <span>${escapeHtml(row.profile.name)}</span>
        <span>${row.correct}</span>
        <span>${row.pending}</span>
      </div>
    `).join("")
    : `<div class="empty-state">No profiles yet.</div>`;
}

function renderProfileSelect() {
  els.profileSelect.innerHTML = state.profiles.length
    ? state.profiles.map((profile) => `<option value="${profile.id}">${escapeHtml(profile.name)}</option>`).join("")
    : `<option value="">No profiles created</option>`;
}

async function createProfile(event) {
  event.preventDefault();
  const name = document.querySelector("#newName").value.trim();
  const pin = document.querySelector("#newPin").value.trim();

  if (!/^\d{4}$/.test(pin)) {
    showToast("PIN must be exactly 4 digits.");
    return;
  }

  if (state.profiles.some((profile) => profile.name.toLowerCase() === name.toLowerCase())) {
    showToast("That display name is already taken.");
    return;
  }

  const profile = {
    id: crypto.randomUUID(),
    name,
    pin,
    createdAt: new Date().toISOString()
  };

  state.profiles.push(profile);
  state.currentProfileId = profile.id;
  localStorage.setItem(CURRENT_PROFILE_KEY, profile.id);
  state.draftTips = {};
  await persist();
  event.target.reset();
  showToast(`Logged in as ${name}`);
  setView("tips");
  render();
}

async function loginProfile(event) {
  event.preventDefault();
  const profileId = els.profileSelect.value;
  const pin = document.querySelector("#loginPin").value.trim();
  const profile = state.profiles.find((candidate) => candidate.id === profileId);

  if (!profile || profile.pin !== pin) {
    showToast("Profile or PIN is incorrect.");
    return;
  }

  state.currentProfileId = profile.id;
  localStorage.setItem(CURRENT_PROFILE_KEY, profile.id);
  state.draftTips = { ...(state.tips[profile.id] || {}) };
  event.target.reset();
  showToast(`Logged in as ${profile.name}`);
  setView("tips");
  render();
}

async function saveCurrentTips() {
  const profile = getCurrentProfile();
  if (!profile) {
    showToast("Create or login to a profile first.");
    setView("profile");
    return;
  }

  const nextTips = { ...(state.tips[profile.id] || {}) };
  state.fixtures.forEach((match) => {
    if (!isLocked(match) && state.draftTips[match.id]) {
      nextTips[match.id] = state.draftTips[match.id];
    }
  });

  state.tips[profile.id] = nextTips;
  await persist();
  showToast("Tips saved.");
  render();
}

async function persist() {
  try {
    await storageAdapter.save({
      profiles: state.profiles,
      tips: state.tips
    });
  } catch (error) {
    console.error(error);
    showToast("Could not save to Firebase. Check Firestore rules.");
    throw error;
  }
}

function getCurrentProfile() {
  return state.profiles.find((profile) => profile.id === state.currentProfileId);
}

function isLocked(match) {
  return match.locked || new Date(match.lockAtUtc).getTime() <= Date.now();
}

function getPickers(matchId, teamId) {
  return state.profiles.filter((profile) => state.tips[profile.id]?.[matchId] === teamId);
}

function countCorrect(profileId) {
  return state.fixtures.filter((match) => {
    const pick = state.tips[profileId]?.[match.id];
    return match.status === "FINISHED" && match.winnerTeamId && pick === match.winnerTeamId;
  }).length;
}

function countPending(profileId) {
  return state.fixtures.filter((match) => {
    const pick = state.tips[profileId]?.[match.id];
    return pick && match.status !== "FINISHED";
  }).length;
}

function getNextLockoutText() {
  const next = state.fixtures
    .filter((match) => !isLocked(match))
    .sort((a, b) => new Date(a.lockAtUtc) - new Date(b.lockAtUtc))[0];

  return next ? `${formatDate(next.lockAtUtc)} for ${next.homeTeam.shortName} v ${next.awayTeam.shortName}` : "All current matches locked";
}

function teamMarkup(team, score) {
  const flag = team.flag || TEAM_FLAGS_BY_CODE[team.shortName] || "";

  return `
    <div class="team-row">
      <span class="team-name">
        <span class="flag" aria-hidden="true">${escapeHtml(flag)}</span>
        <span>${escapeHtml(team.name)}</span>
      </span>
      <span class="team-score">${score ?? "-"}</span>
    </div>
  `;
}

function pickColumn(title, pickers) {
  return `
    <div class="pick-column">
      <h4>${escapeHtml(title)}</h4>
      <div class="pick-list">
        ${pickers.length ? pickers.map((profile) => `<span class="player-pill">${escapeHtml(profile.name)}</span>`).join("") : `<span class="label">No picks</span>`}
      </div>
    </div>
  `;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function emptyState(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => els.toast.classList.remove("show"), 2600);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
