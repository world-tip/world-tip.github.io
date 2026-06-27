import { readFile, writeFile } from "node:fs/promises";

const API_BASE = "https://api.football-data.org/v4";
const DATA_FILE = new URL("../data/fixtures.json", import.meta.url);
const TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const COMPETITION_CODE = process.env.FOOTBALL_DATA_COMPETITION || "WC";
const SEASON = process.env.FOOTBALL_DATA_SEASON || "2026";
const MIN_REQUESTS_AVAILABLE = Number(process.env.MIN_REQUESTS_AVAILABLE || 2);

const KNOCKOUT_STAGES = new Set([
  "LAST_32",
  "ROUND_OF_32",
  "LAST_16",
  "ROUND_OF_16",
  "EIGHTH_FINALS",
  "QUARTER_FINALS",
  "SEMI_FINALS",
  "THIRD_PLACE",
  "FINAL"
]);

if (!TOKEN) {
  throw new Error("Missing FOOTBALL_DATA_TOKEN. Add it as a GitHub Actions repository secret.");
}

const data = JSON.parse(await readFile(DATA_FILE, "utf8"));
const lockMinutes = Number(data.lockMinutesBeforeKickoff || 15);
const existingByApiId = new Map(
  (data.matches || [])
    .filter((match) => match.footballDataMatchId != null)
    .map((match) => [String(match.footballDataMatchId), match])
);

const apiUrl = new URL(`${API_BASE}/competitions/${COMPETITION_CODE}/matches`);
apiUrl.searchParams.set("season", SEASON);

const response = await fetch(apiUrl, {
  headers: {
    "X-Auth-Token": TOKEN
  }
});

const throttle = readThrottleHeaders(response);
data.api = {
  ...(data.api || {}),
  competitionCode: COMPETITION_CODE,
  season: SEASON,
  endpoint: scrubToken(apiUrl.toString()),
  lastStatus: response.status,
  lastCheckedAtUtc: new Date().toISOString(),
  throttle
};

if (throttle.requestsAvailable !== null && throttle.requestsAvailable <= MIN_REQUESTS_AVAILABLE) {
  await writeFile(DATA_FILE, `${JSON.stringify(data, null, 2)}\n`);
  console.log(
    `Skipping update: only ${throttle.requestsAvailable} football-data.org requests remain. ` +
      `Counter resets in ${throttle.requestCounterResetSeconds ?? "unknown"} seconds.`
  );
  process.exit(0);
}

if (!response.ok) {
  const body = await response.text();
  data.api.lastError = truncate(body || response.statusText, 500);
  await writeFile(DATA_FILE, `${JSON.stringify(data, null, 2)}\n`);
  throw new Error(`football-data.org returned ${response.status}: ${data.api.lastError}`);
}

const payload = await response.json();
const apiMatches = (payload.matches || [])
  .filter(isKnockoutMatch)
  .sort(compareMatches);

data.competition = {
  name: payload.competition?.name || data.competition?.name || "FIFA World Cup",
  code: payload.competition?.code || COMPETITION_CODE,
  stageStart: "Round of 32",
  source: "https://www.football-data.org/"
};

if (apiMatches.length > 0) {
  data.matches = apiMatches.map((apiMatch) => normalizeMatch(apiMatch, existingByApiId, lockMinutes));
} else {
  data.matches = (data.matches || []).map((match) => ({
    ...match,
    locked: new Date(match.lockAtUtc).getTime() <= Date.now()
  }));
  data.api.lastWarning = "No knockout matches returned by football-data.org; preserved existing fixture data.";
}

data.updatedAtUtc = new Date().toISOString();
delete data.api.lastError;

if (apiMatches.length > 0) {
  delete data.api.lastWarning;
}

await writeFile(DATA_FILE, `${JSON.stringify(data, null, 2)}\n`);

console.log(`Updated ${data.matches.length} ${data.competition.name} knockout matches.`);
console.log(
  `football-data.org requests remaining: ${throttle.requestsAvailable ?? "unknown"}; ` +
    `reset in ${throttle.requestCounterResetSeconds ?? "unknown"}s.`
);

function normalizeMatch(apiMatch, previousMatches, lockMinutesBeforeKickoff) {
  const previous = previousMatches.get(String(apiMatch.id));
  const kickoffUtc = apiMatch.utcDate;
  const lockAtUtc = new Date(new Date(kickoffUtc).getTime() - lockMinutesBeforeKickoff * 60 * 1000).toISOString();
  const homeTeam = normalizeTeam(apiMatch.homeTeam, previous?.homeTeam, "home", apiMatch.id);
  const awayTeam = normalizeTeam(apiMatch.awayTeam, previous?.awayTeam, "away", apiMatch.id);
  const score = normalizeScore(apiMatch);

  return {
    id: previous?.id || `fd-${apiMatch.id}`,
    footballDataMatchId: apiMatch.id,
    stage: formatStage(apiMatch.stage),
    apiStage: apiMatch.stage || null,
    matchday: apiMatch.matchday ?? null,
    kickoffUtc,
    lockAtUtc,
    locked: new Date(lockAtUtc).getTime() <= Date.now(),
    status: apiMatch.status,
    homeTeam,
    awayTeam,
    score,
    winnerTeamId: getWinnerTeamId(apiMatch, homeTeam, awayTeam, score)
  };
}

function normalizeTeam(apiTeam, previousTeam, side, matchId) {
  const code = apiTeam?.tla || apiTeam?.shortName || apiTeam?.name || previousTeam?.shortName || side;
  const id = previousTeam?.id || slug(code || `${side}-${matchId}`);

  return {
    id,
    footballDataTeamId: apiTeam?.id ?? previousTeam?.footballDataTeamId ?? null,
    name: apiTeam?.name || previousTeam?.name || `${capitalize(side)} TBD`,
    shortName: apiTeam?.tla || apiTeam?.shortName || previousTeam?.shortName || "TBD",
    flag: previousTeam?.flag || flagEmoji(apiTeam?.area?.code || apiTeam?.tla)
  };
}

function normalizeScore(apiMatch) {
  const scoreSource = apiMatch.score?.fullTime || apiMatch.score?.regularTime || {};
  return {
    home: scoreSource.home ?? null,
    away: scoreSource.away ?? null
  };
}

function getWinnerTeamId(apiMatch, homeTeam, awayTeam, score) {
  if (apiMatch.status !== "FINISHED") {
    return null;
  }

  if (apiMatch.score?.winner === "HOME_TEAM") {
    return homeTeam.id;
  }

  if (apiMatch.score?.winner === "AWAY_TEAM") {
    return awayTeam.id;
  }

  if (score.home > score.away) {
    return homeTeam.id;
  }

  if (score.away > score.home) {
    return awayTeam.id;
  }

  return null;
}

function isKnockoutMatch(match) {
  if (KNOCKOUT_STAGES.has(match.stage)) {
    return true;
  }

  // Keep future compatibility if football-data.org changes the exact enum.
  return typeof match.stage === "string" && !match.stage.startsWith("GROUP_") && match.stage !== "QUALIFICATION";
}

function compareMatches(a, b) {
  return new Date(a.utcDate) - new Date(b.utcDate) || Number(a.id) - Number(b.id);
}

function readThrottleHeaders(response) {
  return {
    apiVersion: response.headers.get("x-api-version"),
    authenticatedClient: response.headers.get("x-authenticated-client"),
    requestCounterResetSeconds: numberOrNull(response.headers.get("x-requestcounter-reset")),
    requestsAvailable: numberOrNull(response.headers.get("x-requestsavailable"))
  };
}

function numberOrNull(value) {
  if (value == null || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatStage(stage) {
  const labels = {
    LAST_32: "Round of 32",
    ROUND_OF_32: "Round of 32",
    LAST_16: "Round of 16",
    ROUND_OF_16: "Round of 16",
    EIGHTH_FINALS: "Round of 16",
    QUARTER_FINALS: "Quarter-finals",
    SEMI_FINALS: "Semi-finals",
    THIRD_PLACE: "Third place",
    FINAL: "Final"
  };

  if (labels[stage]) {
    return labels[stage];
  }

  return String(stage || "Match")
    .toLowerCase()
    .split("_")
    .map(capitalize)
    .join(" ");
}

function flagEmoji(countryCode) {
  if (!countryCode || !/^[A-Z]{2}$/.test(countryCode)) {
    return "";
  }

  return [...countryCode]
    .map((char) => String.fromCodePoint(127397 + char.charCodeAt(0)))
    .join("");
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "team";
}

function capitalize(value) {
  const text = String(value || "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function scrubToken(value) {
  return value.replace(TOKEN, "REDACTED");
}

function truncate(value, maxLength) {
  const text = String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
