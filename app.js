const FIXTURE_URL = "data/fixtures.json";
const CURRENT_PROFILE_KEY = "worldCupTippingProfileId.v1";
const SHOW_LADDER_TIP_HISTORY = true;
const ENABLE_LADDER_TEST_MATCH = false;
const SHOW_LADDER_POINTS_GRAPH = true;
const GROUP_MATCHES_BY_STAGE = true;

const firebaseConfig = {
  apiKey: "AIzaSyBVJkCwnVe80fqqCAsT4YsUG-JRIE-gG4I",
  authDomain: "world-tip-4a2c3.firebaseapp.com",
  projectId: "world-tip-4a2c3",
  storageBucket: "world-tip-4a2c3.firebasestorage.app",
  messagingSenderId: "862737079191",
  appId: "1:862737079191:web:ce598ae571a5ca559ac2d2",
  measurementId: "G-NK1CXS6P9E"
};

let firebaseApi = null;
let db = null;
const firebaseReady = initializeFirebase();

async function initializeFirebase() {
  const [{ initializeApp }, firestore] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js")
  ]);

  const firebaseApp = initializeApp(firebaseConfig);
  db = firestore.getFirestore(firebaseApp);
  firebaseApi = firestore;
}

async function ensureFirebase() {
  await firebaseReady;

  if (!firebaseApi || !db) {
    throw new Error("Firebase did not initialize.");
  }

  return firebaseApi;
}

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
  draftTips: {},
  selectedStage: ""
};

const els = {
  tabs: document.querySelectorAll(".tab"),
  views: document.querySelectorAll(".view"),
  stageTabs: document.querySelector("#stageTabs"),
  matchesList: document.querySelector("#matchesList"),
  ladderRows: document.querySelector("#ladderRows"),
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
    const { collection, getDocs } = await ensureFirebase();
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
    const { doc, setDoc } = await ensureFirebase();
    const profileWrites = nextState.profiles.map((profile) => setDoc(doc(db, "profiles", profile.id), {
      name: profile.name,
      pin: profile.pin,
      createdAt: profile.createdAt,
      startingPoints: startingPoints(profile)
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
  state.draftTips = {};
  bindEvents();
  applyLadderTestMatch();
  render();

  try {
    const saved = await storageAdapter.load();
    state.profiles = saved.profiles || [];
    state.tips = saved.tips || {};
    applyLadderTestMatch();
    render();
  } catch (error) {
    console.error(error);
    showToast("Could not load Firebase data. Check Firestore setup.");
  }
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

  document.addEventListener("pointerdown", clearDraftOnOutsidePointerDown, true);
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

  els.profileStatus.textContent = profile ? profile.name : "No profile";
  els.currentProfileName.textContent = profile ? profile.name : "Create or login";
  els.matchCount.textContent = String(state.fixtures.length);
  els.nextLockout.textContent = getNextLockoutText();

  renderProfileSelect();
  renderStageTabs();
  renderMatches();
  renderLadder();
}

function applyLadderTestMatch() {
  if (!ENABLE_LADDER_TEST_MATCH) {
    return;
  }

  const testMatches = [
    {
      id: "local-test-ladder-match-1",
      footballDataMatchId: null,
      stage: "Test match 1",
      kickoffUtc: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      lockAtUtc: new Date(Date.now() - 135 * 60 * 1000).toISOString(),
      locked: true,
      status: "FINISHED",
      homeTeam: {
        id: "test-arg",
        name: "Argentina",
        shortName: "ARG",
        flag: "🇦🇷"
      },
      awayTeam: {
        id: "test-bra",
        name: "Brazil",
        shortName: "BRA",
        flag: "🇧🇷"
      },
      score: {
        home: 1,
        away: 0
      },
      winnerTeamId: "test-arg"
    },
    {
      id: "local-test-ladder-match-2",
      footballDataMatchId: null,
      stage: "Test match 2",
      kickoffUtc: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      lockAtUtc: new Date(Date.now() - 75 * 60 * 1000).toISOString(),
      locked: true,
      status: "FINISHED",
      homeTeam: {
        id: "test-jpn",
        name: "Japan",
        shortName: "JPN",
        flag: "🇯🇵"
      },
      awayTeam: {
        id: "test-usa",
        name: "United States",
        shortName: "USA",
        flag: "🇺🇸"
      },
      score: {
        home: 2,
        away: 3
      },
      winnerTeamId: "test-usa"
    }
  ];

  const testMatchIds = new Set(testMatches.map((match) => match.id));
  state.fixtures = [...testMatches, ...state.fixtures.filter((match) => !testMatchIds.has(match.id))];

  state.profiles.forEach((profile) => {
    const existingTips = state.tips[profile.id] || {};
    state.tips[profile.id] = {
      ...existingTips,
      ...Object.fromEntries(testMatches.map((match, index) => [match.id, testPickForProfile(profile.id, match, index)]))
    };
  });
}

function testPickForProfile(profileId, match, index) {
  const hash = [...`${profileId}-${match.id}-${index}`].reduce((total, char) => total + char.charCodeAt(0), 0);
  return hash % 2 === 0 ? match.homeTeam.id : match.awayTeam.id;
}

function renderStageTabs() {
  if (!els.stageTabs) {
    return;
  }

  if (!GROUP_MATCHES_BY_STAGE || !state.fixtures.length) {
    els.stageTabs.innerHTML = "";
    els.stageTabs.hidden = true;
    return;
  }

  const stages = matchStages();
  if (!state.selectedStage || !stages.includes(state.selectedStage)) {
    state.selectedStage = stages[0] || "";
  }

  els.stageTabs.hidden = false;
  els.stageTabs.innerHTML = stages.map((stage) => `
    <button class="stage-tab ${stage === state.selectedStage ? "active" : ""}" data-stage="${escapeHtml(stage)}" type="button">
      ${escapeHtml(stage)}
    </button>
  `).join("");

  els.stageTabs.querySelectorAll(".stage-tab").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedStage = button.dataset.stage;
      state.draftTips = {};
      renderStageTabs();
      renderMatches();
    });
  });
}

function renderMatches() {
  const matches = visibleMatches();

  if (!state.fixtures.length) {
    els.matchesList.innerHTML = emptyState("No fixtures loaded yet.");
    return;
  }

  if (!matches.length) {
    els.matchesList.innerHTML = emptyState("No matches in this round yet.");
    return;
  }

  els.matchesList.innerHTML = matches.map((match) => {
    try {
      return matchCardMarkup(match);
    } catch (error) {
      console.error(error);
      return emptyState(`Could not render ${escapeHtml(match.stage || "match")}.`);
    }
  }).join("");

  els.matchesList.querySelectorAll(".team-pick").forEach((button) => {
    button.addEventListener("click", () => stageTip(button.dataset.matchId, button.dataset.teamId));
  });

  els.matchesList.querySelectorAll(".confirm-tip").forEach((button) => {
    button.addEventListener("click", () => confirmTip(button.dataset.matchId));
  });
}

function visibleMatches() {
  if (!GROUP_MATCHES_BY_STAGE || !state.selectedStage) {
    return state.fixtures;
  }

  return state.fixtures.filter((match) => match.stage === state.selectedStage);
}

function matchStages() {
  const stages = [];
  state.fixtures.forEach((match) => {
    if (match.stage && !stages.includes(match.stage)) {
      stages.push(match.stage);
    }
  });
  return stages;
}

function matchCardMarkup(match) {
  const locked = isLocked(match);
  const homePickers = getPickers(match.id, match.homeTeam.id);
  const awayPickers = getPickers(match.id, match.awayTeam.id);
  const savedPick = state.tips[state.currentProfileId]?.[match.id] || "";
  const stagedPick = state.draftTips[match.id] || "";
  const confirmLabel = savedPick ? "Confirm change" : "Confirm tip";

  return `
    <article class="match-card" data-match-card="${match.id}">
      <div class="match-meta">
        <span>${escapeHtml(match.stage)} - ${formatDate(match.kickoffUtc)}</span>
        <span class="lock-badge ${locked ? "locked" : ""}">${locked ? "Picks visible" : `Locks ${formatTime(match.lockAtUtc)}`}</span>
      </div>
      <div class="tip-action-area">
        ${teamMarkup(match, match.homeTeam, match.score?.home, savedPick, stagedPick, locked)}
        ${teamMarkup(match, match.awayTeam, match.score?.away, savedPick, stagedPick, locked)}
        ${!locked && stagedPick ? `
          <div class="confirm-row">
            <button class="button primary confirm-tip" data-match-id="${match.id}" type="button">${confirmLabel}</button>
          </div>
        ` : ""}
      </div>
      ${locked ? `
        <div class="pick-columns">
          ${pickColumn(match.homeTeam.shortName, homePickers)}
          ${pickColumn(match.awayTeam.shortName, awayPickers)}
        </div>
      ` : `<p class="hidden-picks">Picks are hidden until lockout.</p>`}
    </article>
  `;
}

function renderLadder() {
  const rows = state.profiles
    .map((profile) => ({
      profile,
      points: countPoints(profile.id),
      pending: countPending(profile.id)
    }))
    .sort((a, b) => b.points - a.points || a.pending - b.pending || a.profile.name.localeCompare(b.profile.name));

  els.ladderRows.innerHTML = rows.length
    ? `${rows.map((row, index) => `
      <div class="ladder-row ${SHOW_LADDER_TIP_HISTORY ? "with-tip-history" : ""}">
        <span>${index + 1}</span>
        ${ladderPlayerCell(row.profile)}
        <span>${row.points}</span>
        <span>${row.pending}</span>
      </div>
    `).join("")}${ladderPointsGraph(rows.map((row) => row.profile))}`
    : `<div class="empty-state">No profiles yet.</div>`;
}

function ladderPointsGraph(profiles) {
  if (!SHOW_LADDER_POINTS_GRAPH || profiles.length === 0) {
    return "";
  }

  const matches = graphMatches();
  if (matches.length === 0) {
    return `
      <div class="points-graph">
        <div class="points-graph-head">
          <div>
            <p class="eyebrow">History</p>
            <h4>Points over time</h4>
          </div>
        </div>
        <div class="points-graph-empty">No completed or locked matches with results yet.</div>
      </div>
    `;
  }

  const series = profiles.map((profile, index) => pointsSeriesForProfile(profile, matches, index));
  const plottedValues = series.flatMap((item) => item.values.filter((points) => points !== null));
  const maxPoints = Math.max(1, ...plottedValues);
  const width = 720;
  const height = 260;
  const pad = { top: 22, right: 26, bottom: 38, left: 36 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const xFor = (index) => pad.left + (matches.length === 1 ? plotWidth : (plotWidth * index) / (matches.length - 1));
  const yFor = (points) => pad.top + plotHeight - (plotHeight * points) / maxPoints;
  const gridValues = graphGridValues(maxPoints);
  const lines = series.map((item) => {
    const points = item.values
      .map((value, index) => value === null ? null : {
        x: xFor(index).toFixed(1),
        y: yFor(value).toFixed(1)
      })
      .filter(Boolean);

    if (points.length === 0) {
      return "";
    }

    const line = points.length > 1
      ? `<polyline class="points-line" points="${points.map((point) => `${point.x},${point.y}`).join(" ")}" style="--series-color:${item.color}"></polyline>`
      : "";
    const dots = points.map((point) => `<circle class="points-dot" cx="${point.x}" cy="${point.y}" r="3.5" style="--series-color:${item.color}"></circle>`).join("");

    return `${line}${dots}`;
  }).join("");

  return `
    <div class="points-graph">
      <div class="points-graph-head">
        <div>
          <p class="eyebrow">History</p>
          <h4>Points over time</h4>
        </div>
      </div>
      <div class="points-graph-frame">
        <svg class="points-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Points over time chart">
          ${gridValues.map((value) => `
            <line class="points-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${yFor(value).toFixed(1)}" y2="${yFor(value).toFixed(1)}"></line>
            <text class="points-axis-label" x="${pad.left - 10}" y="${(yFor(value) + 4).toFixed(1)}" text-anchor="end">${value}</text>
          `).join("")}
          ${matches.map((match, index) => `<text class="points-axis-label" x="${xFor(index).toFixed(1)}" y="${height - 10}" text-anchor="middle">${index + 1}</text>`).join("")}
          ${lines}
        </svg>
      </div>
      <div class="points-legend">
        ${series.map((item) => `<span class="points-legend-item"><span class="points-legend-swatch" style="--series-color:${item.color}"></span>${escapeHtml(item.profile.name)}</span>`).join("")}
      </div>
    </div>
  `;
}

function graphMatches() {
  return state.fixtures
    .filter((match) => match.status === "FINISHED" && match.winnerTeamId && hasPlayableTeams(match))
    .sort((a, b) => new Date(a.kickoffUtc) - new Date(b.kickoffUtc));
}

function pointsSeriesForProfile(profile, matches, index) {
  let total = startingPoints(profile);
  const joinedAt = profileCreatedAtTime(profile);
  const values = matches.map((match) => {
    const lockAt = new Date(match.lockAtUtc || match.kickoffUtc).getTime();
    if (Number.isFinite(joinedAt) && Number.isFinite(lockAt) && lockAt < joinedAt) {
      return null;
    }

    if (state.tips[profile.id]?.[match.id] === match.winnerTeamId) {
      total += 1;
    }
    return total;
  });

  return {
    profile,
    values,
    color: graphColor(index)
  };
}

function profileCreatedAtTime(profile) {
  const createdAt = new Date(profile?.createdAt || 0).getTime();
  return Number.isFinite(createdAt) ? createdAt : null;
}

function graphGridValues(maxPoints) {
  const middle = Math.ceil(maxPoints / 2);
  return [...new Set([0, middle, maxPoints])].sort((a, b) => a - b);
}

function graphColor(index) {
  const colors = ["#39c48d", "#65a7df", "#f0b83f", "#ff8f70", "#c79cff", "#6ee7e7", "#ff75a0", "#a7e36d"];
  return colors[index % colors.length];
}

function ladderPlayerCell(profile) {
  if (!SHOW_LADDER_TIP_HISTORY) {
    return `<span>${escapeHtml(profile.name)}</span>`;
  }

  const history = ladderTipHistory(profile.id);
  return `
    <span class="ladder-player-cell">
      <span class="ladder-player-name">${escapeHtml(profile.name)}</span>
      ${history.length ? `<span class="tip-history-strip" aria-label="Locked historical tips">${history.join("")}</span>` : ""}
    </span>
  `;
}

function ladderTipHistory(profileId) {
  return state.fixtures
    .filter((match) => isLocked(match) && hasPlayableTeams(match))
    .map((match) => ladderTipIndicator(match, state.tips[profileId]?.[match.id]))
    .filter(Boolean);
}

function hasPlayableTeams(match) {
  return match.homeTeam?.shortName !== "TBD" && match.awayTeam?.shortName !== "TBD";
}

function ladderTipIndicator(match, pickedTeamId) {
  const homePicked = pickedTeamId === match.homeTeam.id;
  const awayPicked = pickedTeamId === match.awayTeam.id;

  if (pickedTeamId && !homePicked && !awayPicked) {
    return "";
  }

  const tipTitle = pickedTeamId
    ? `${match.homeTeam.shortName} v ${match.awayTeam.shortName}`
    : `No tip: ${match.homeTeam.shortName} v ${match.awayTeam.shortName}`;

  return `
    <span class="tip-orb ${pickedTeamId ? "" : "no-tip"}" title="${escapeHtml(tipTitle)}" aria-label="${escapeHtml(tipTitle)}">
      <span class="tip-orb-half home ${homePicked ? "picked" : ""}">${escapeHtml(teamFlag(match.homeTeam))}</span>
      <span class="tip-orb-half away ${awayPicked ? "picked" : ""}">${escapeHtml(teamFlag(match.awayTeam))}</span>
    </span>
  `;
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
    createdAt: new Date().toISOString(),
    startingPoints: lateJoinStartingPoints()
  };

  state.profiles.push(profile);
  state.currentProfileId = profile.id;
  localStorage.setItem(CURRENT_PROFILE_KEY, profile.id);
  state.draftTips = {};
  await persist();
  event.target.reset();
  showToast(`Logged in as ${name}`);
  setView("matches");
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
  state.draftTips = {};
  event.target.reset();
  showToast(`Logged in as ${profile.name}`);
  setView("matches");
  render();
}

function stageTip(matchId, teamId) {
  const profile = getCurrentProfile();
  const match = state.fixtures.find((candidate) => candidate.id === matchId);

  if (!profile) {
    showToast("Create or login to a profile first.");
    setView("profile");
    return;
  }

  if (!match || isLocked(match)) {
    return;
  }

  const savedPick = state.tips[profile.id]?.[matchId] || "";

  if (state.draftTips[matchId] === teamId || savedPick === teamId) {
    state.draftTips = {};
  } else {
    state.draftTips = { [matchId]: teamId };
  }

  renderMatches();
}

async function confirmTip(matchId) {
  const profile = getCurrentProfile();
  const match = state.fixtures.find((candidate) => candidate.id === matchId);
  const stagedPick = state.draftTips[matchId];

  if (!profile) {
    showToast("Create or login to a profile first.");
    setView("profile");
    return;
  }

  if (!match || isLocked(match) || !stagedPick) {
    return;
  }

  state.tips[profile.id] = {
    ...(state.tips[profile.id] || {}),
    [matchId]: stagedPick
  };
  state.draftTips = {};
  await persist();
  showToast("Tip confirmed.");
  render();
}

function clearDraftOnOutsidePointerDown(event) {
  if (!Object.keys(state.draftTips).length || event.target.closest(".tip-action-area")) {
    return;
  }

  state.draftTips = {};
  renderMatches();
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

function countPoints(profileId) {
  const profile = state.profiles.find((candidate) => candidate.id === profileId);
  return startingPoints(profile) + countCorrect(profileId);
}

function countCorrect(profileId) {
  return state.fixtures.filter((match) => {
    const pick = state.tips[profileId]?.[match.id];
    return match.status === "FINISHED" && match.winnerTeamId && pick === match.winnerTeamId;
  }).length;
}

function lateJoinStartingPoints() {
  if (state.profiles.length === 0) {
    return 0;
  }

  const totalPoints = state.profiles.reduce((total, profile) => total + countPoints(profile.id), 0);
  return Math.floor(totalPoints / state.profiles.length);
}

function startingPoints(profile) {
  const value = Number(profile?.startingPoints || 0);
  return Number.isFinite(value) ? value : 0;
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

function teamMarkup(match, team, score, savedPick, stagedPick, locked) {
  const flag = teamFlag(team);
  const unavailable = team.shortName === "TBD";
  const disabled = locked || unavailable ? "disabled" : "";
  const stateClass = getTeamPickClass(team.id, savedPick, stagedPick);

  return `
    <button class="team-row team-pick ${stateClass}" data-match-id="${match.id}" data-team-id="${team.id}" ${disabled} type="button">
      <span class="team-name">
        <span class="flag" aria-hidden="true">${escapeHtml(flag)}</span>
        <span>${escapeHtml(team.name)}</span>
      </span>
      <span class="team-score">${score ?? "-"}</span>
    </button>
  `;
}

function teamFlag(team) {
  return team?.flag || TEAM_FLAGS_BY_CODE[team?.shortName] || "";
}

function getTeamPickClass(teamId, savedPick, stagedPick) {
  if (stagedPick === teamId) {
    return "pick-staged";
  }

  if (savedPick === teamId) {
    return "pick-confirmed";
  }

  return "pick-default";
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
