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

const SPECIAL_TEAM_FLAGS = {
  ENG: "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
  NIR: "🇬🇧",
  SCO: "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
  WAL: "🏴󠁧󠁢󠁷󠁬󠁳󠁿"
};

const FIFA_TLA_TO_COUNTRY_CODE = {
  AFG: "AF",
  ALB: "AL",
  ALG: "DZ",
  AND: "AD",
  ANG: "AO",
  ARG: "AR",
  ARM: "AM",
  AUS: "AU",
  AUT: "AT",
  AZE: "AZ",
  BAH: "BS",
  BHR: "BH",
  BAN: "BD",
  BEL: "BE",
  BEN: "BJ",
  BIH: "BA",
  BLR: "BY",
  BOL: "BO",
  BRA: "BR",
  BUL: "BG",
  BFA: "BF",
  CMR: "CM",
  CAN: "CA",
  CPV: "CV",
  CHI: "CL",
  CHN: "CN",
  COL: "CO",
  CRC: "CR",
  CRO: "HR",
  CUB: "CU",
  DOM: "DO",
  CZE: "CZ",
  COD: "CD",
  CIV: "CI",
  CUR: "CW",
  DEN: "DK",
  ECU: "EC",
  EGY: "EG",
  ESP: "ES",
  FIN: "FI",
  FRA: "FR",
  GAB: "GA",
  GAM: "GM",
  GEO: "GE",
  GUA: "GT",
  GER: "DE",
  GHA: "GH",
  GRE: "GR",
  GUI: "GN",
  HAI: "HT",
  HON: "HN",
  HUN: "HU",
  IDN: "ID",
  IRL: "IE",
  IRN: "IR",
  IRQ: "IQ",
  ISL: "IS",
  ISR: "IL",
  ITA: "IT",
  JAM: "JM",
  JOR: "JO",
  JPN: "JP",
  KOR: "KR",
  KSA: "SA",
  LBN: "LB",
  KUW: "KW",
  MEX: "MX",
  MAR: "MA",
  MLI: "ML",
  MKD: "MK",
  NED: "NL",
  NGA: "NG",
  NOR: "NO",
  NZL: "NZ",
  OMA: "OM",
  PAN: "PA",
  PAR: "PY",
  PER: "PE",
  POL: "PL",
  PLE: "PS",
  POR: "PT",
  QAT: "QA",
  ROU: "RO",
  RSA: "ZA",
  RUS: "RU",
  SEN: "SN",
  SRB: "RS",
  SUI: "CH",
  SLV: "SV",
  SVK: "SK",
  SVN: "SI",
  SWE: "SE",
  SUR: "SR",
  SYR: "SY",
  TUN: "TN",
  THA: "TH",
  TRI: "TT",
  TUR: "TR",
  UKR: "UA",
  UAE: "AE",
  URU: "UY",
  USA: "US",
  UZB: "UZ",
  VEN: "VE",
  VIE: "VN"
};

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
  const shortName = apiTeam?.tla || apiTeam?.shortName || previousTeam?.shortName || "TBD";
  const flag = flagForTeam(apiTeam, previousTeam, shortName);

  return {
    id,
    footballDataTeamId: apiTeam?.id ?? previousTeam?.footballDataTeamId ?? null,
    name: apiTeam?.name || previousTeam?.name || `${capitalize(side)} TBD`,
    shortName,
    flag
  };
}

function normalizeScore(apiMatch) {
  const fullTime = scorePair(apiMatch.score?.fullTime);
  const regularTime = scorePair(apiMatch.score?.regularTime);
  const extraTime = scorePair(apiMatch.score?.extraTime);
  const isShootout = apiMatch.score?.duration === "PENALTY_SHOOTOUT" || Boolean(apiMatch.score?.penalties);
  const matchScore = isShootout
    ? addScores(regularTime, extraTime) || regularTime || fullTime
    : fullTime || regularTime;
  const derivedPenalties = isShootout ? subtractScores(fullTime, matchScore) : null;
  const penalties = derivedPenalties || scorePair(apiMatch.score?.penalties);

  return {
    home: matchScore?.home ?? null,
    away: matchScore?.away ?? null,
    penalties
  };
}

function scorePair(score) {
  if (!score || score.home == null || score.away == null) {
    return null;
  }

  return {
    home: score.home,
    away: score.away
  };
}

function addScores(first, second) {
  if (!first && !second) {
    return null;
  }

  return {
    home: (first?.home ?? 0) + (second?.home ?? 0),
    away: (first?.away ?? 0) + (second?.away ?? 0)
  };
}

function subtractScores(total, part) {
  if (!total || !part) {
    return null;
  }

  const home = total.home - part.home;
  const away = total.away - part.away;
  if (home < 0 || away < 0) {
    return null;
  }

  return { home, away };
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

  if (score.penalties?.home > score.penalties?.away) {
    return homeTeam.id;
  }

  if (score.penalties?.away > score.penalties?.home) {
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

function flagForTeam(apiTeam, previousTeam, shortName) {
  const tla = String(apiTeam?.tla || shortName || "").toUpperCase();
  const specialFlag = SPECIAL_TEAM_FLAGS[tla];

  if (specialFlag) {
    return specialFlag;
  }

  const countryCode = countryCodeForTeam(apiTeam, tla);
  return flagEmoji(countryCode) || previousTeam?.flag || "";
}

function countryCodeForTeam(apiTeam, tla) {
  const possibleCodes = [
    apiTeam?.area?.code,
    apiTeam?.countryCode,
    FIFA_TLA_TO_COUNTRY_CODE[tla]
  ];

  const exactCode = possibleCodes.find((code) => typeof code === "string" && /^[A-Z]{2}$/.test(code));
  if (exactCode) {
    return exactCode;
  }

  return "";
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
