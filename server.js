const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const { exec } = require("child_process");

const PORT = process.env.PORT || 3000;
const HELPER_PORT = process.env.COUCH_HELPER_PORT || 3001;
const PUBLIC_DIR = path.join(__dirname, "public");

const PHASE = {
  LOBBY: "LOBBY",
  ACTIVE: "ACTIVE",
  FINISHED: "FINISHED"
};

const TEAM = {
  RED: "RED",
  BLUE: "BLUE"
};

const NAME_COOLDOWN_TURNS = 3;

const DEFAULT_SETTINGS = {
  blindMode: false,
  blindCouchMode: true
};

const state = createInitialState();

const app = http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsed.pathname;

    if (pathname === "/api/state" && req.method === "GET") {
      const playerId = parsed.searchParams.get("playerId") || "";
      return sendJson(res, 200, { ok: true, state: buildClientState(playerId) });
    }

    if (pathname === "/api/join" && req.method === "POST") {
      const body = await readJson(req);
      const result = joinOrReconnectPlayer(body.playerId, body.nicknameRaw);
      if (!result.ok) {
        return sendJson(res, 400, result);
      }
      return sendJson(res, 200, {
        ok: true,
        playerId: result.playerId,
        state: buildClientState(result.playerId)
      });
    }

    if (pathname === "/api/action" && req.method === "POST") {
      const body = await readJson(req);
      const result = handleAction(body || {});
      const playerId = String(body.playerId || "");
      if (!result.ok) {
        return sendJson(res, 400, result);
      }
      return sendJson(res, 200, { ok: true, state: buildClientState(playerId) });
    }

    if (pathname === "/" && req.method === "GET") {
      return sendFile(res, path.join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8");
    }

    if (req.method === "GET") {
      return serveStatic(pathname, res);
    }

    return sendJson(res, 404, { ok: false, code: "NOT_FOUND", message: "Not found." });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      code: "SERVER_ERROR",
      message: error?.message || "Server error."
    });
  }
});

function handleAction(body) {
  const action = String(body.type || "");
  const playerId = String(body.playerId || "");
  const player = getPlayerById(playerId);
  if (!player && action !== "START_JOIN_FLOW") {
    return fail("UNKNOWN_PLAYER", "Player not found. Rejoin game.");
  }

  if (action === "SET_TEAM") {
    if (state.phase !== PHASE.LOBBY) {
      return fail("INVALID_PHASE", "Teams can only be changed in lobby.");
    }
    if (!isValidTeam(body.team)) {
      return fail("INVALID_TEAM", "Invalid team.");
    }
    player.team = body.team;
    return ok();
  }

  if (action === "REORDER_PLAYERS") {
    if (!player.isHost) {
      return fail("HOST_ONLY", "Only host can reorder players.");
    }
    if (state.phase !== PHASE.LOBBY) {
      return fail("INVALID_PHASE", "Players can only be reordered in lobby.");
    }
    const orderedPlayerIds = Array.isArray(body.orderedPlayerIds) ? body.orderedPlayerIds : [];
    if (orderedPlayerIds.length !== state.players.length) {
      return fail("INVALID_ORDER", "Invalid player order.");
    }
    const existing = new Set(state.players.map((p) => p.id));
    const incoming = new Set(orderedPlayerIds);
    if (incoming.size !== state.players.length) {
      return fail("INVALID_ORDER", "Duplicate player IDs.");
    }
    for (const id of orderedPlayerIds) {
      if (!existing.has(id)) {
        return fail("INVALID_ORDER", "Unknown player ID.");
      }
    }
    const pos = new Map(orderedPlayerIds.map((id, idx) => [id, idx]));
    for (const p of state.players) {
      p.order = pos.get(p.id);
    }
    return ok();
  }

  if (action === "UPDATE_SETTINGS") {
    if (!player.isHost) {
      return fail("HOST_ONLY", "Only host can update settings.");
    }
    if (state.phase !== PHASE.LOBBY) {
      return fail("INVALID_PHASE", "Settings can only be changed in lobby.");
    }
    if (Object.prototype.hasOwnProperty.call(body, "blindMode")) {
      state.settings.blindMode = Boolean(body.blindMode);
    }
    if (Object.prototype.hasOwnProperty.call(body, "blindCouchMode")) {
      state.settings.blindCouchMode = Boolean(body.blindCouchMode);
    }
    return ok();
  }

  if (action === "START_GAME") {
    if (!player.isHost) {
      return fail("HOST_ONLY", "Only host can start game.");
    }
    if (state.phase !== PHASE.LOBBY) {
      return fail("INVALID_PHASE", "Game can only start from lobby.");
    }
    const valid = validateLobbyReadiness();
    if (!valid.ok) {
      return valid;
    }
    startGame();
    return ok();
  }

  if (action === "CALL_NAME") {
    if (state.phase !== PHASE.ACTIVE) {
      return fail("INVALID_PHASE", "Names can only be called during active game.");
    }
    if (state.pendingMove) {
      return fail("MOVE_PENDING", "Move confirmation is still pending.");
    }
    if (state.currentCallerPlayerId !== player.id) {
      return fail("NOT_CALLER", "Only the current caller can call a name.");
    }
    const calledName = String(body.calledName || "").trim();
    if (!calledName) {
      return fail("INVALID_NAME", "Called name is required.");
    }
    const nicknameOwner = state.players.find((p) => p.nicknameRaw === calledName);
    if (!nicknameOwner) {
      return fail("INVALID_NAME", "Called name does not exist.");
    }
    const cooldownTurns = Number(state.nameCooldowns[calledName] || 0);
    if (cooldownTurns > 0) {
      return fail("NAME_ON_COOLDOWN", `Name is on cooldown for ${cooldownTurns} more turn(s).`);
    }
    const calledPlayer = state.players.find((p) => p.assignedName === calledName);
    if (!calledPlayer) {
      return fail("INVALID_STATE", "No player has that assigned name.");
    }
    state.pendingMove = {
      calledName,
      calledPlayerId: calledPlayer.id,
      calledByPlayerId: player.id
    };
    return ok();
  }

  if (action === "CONFIRM_MOVE") {
    if (state.phase !== PHASE.ACTIVE) {
      return fail("INVALID_PHASE", "Moves can only be confirmed during active game.");
    }
    if (!state.pendingMove) {
      return fail("NO_PENDING_MOVE", "No move is pending confirmation.");
    }
    if (state.pendingMove.calledPlayerId !== player.id) {
      return fail("NOT_CALLED_PLAYER", "Only the called player can confirm this move.");
    }
    applyConfirmedMove(player);
    return ok();
  }

  if (action === "END_GAME") {
    if (!player.isHost) {
      return fail("HOST_ONLY", "Only host can end game.");
    }
    resetState();
    return ok();
  }

  return fail("UNKNOWN_ACTION", "Unknown action.");
}

function joinOrReconnectPlayer(providedPlayerId, nicknameRaw) {
  const raw = String(nicknameRaw || "").trim();
  if (!raw) {
    return fail("INVALID_NICKNAME", "Nickname is required.");
  }
  const nicknameNorm = normalizeNickname(raw);
  const playerId = String(providedPlayerId || "").trim() || crypto.randomUUID();

  const existingById = state.players.find((p) => p.id === playerId);
  const existingByNorm = state.players.find((p) => p.nicknameNorm === nicknameNorm);

  if (existingById) {
    if (existingById.nicknameNorm !== nicknameNorm) {
      return fail("NICKNAME_MISMATCH", "Nickname does not match your player.");
    }
    existingById.nicknameRaw = raw;
    ensureHost();
    return { ok: true, playerId };
  }

  if (existingByNorm) {
    return fail("DUPLICATE_NICKNAME", "Nickname already taken.");
  }

  if (state.phase !== PHASE.LOBBY) {
    return fail("LATE_JOIN_DISABLED", "Joining is disabled after game start.");
  }

  state.players.push({
    id: playerId,
    nicknameRaw: raw,
    nicknameNorm,
    team: getDefaultTeamForNewPlayer(),
    order: state.players.length,
    isHost: false,
    assignedName: null,
    seatIndex: null
  });
  ensureHost();
  return { ok: true, playerId };
}

function validateLobbyReadiness() {
  const ordered = getOrderedPlayers();
  if (ordered.length < 8) {
    return fail("NOT_ENOUGH_PLAYERS", "Need at least 8 players.");
  }
  if (ordered.length % 2 !== 0) {
    return fail("TEAM_BALANCE_REQUIRED", "Player count must be even.");
  }
  if (ordered.some((p) => !p.team)) {
    return fail("TEAM_REQUIRED", "Every player must choose a team.");
  }
  const redCount = ordered.filter((p) => p.team === TEAM.RED).length;
  const blueCount = ordered.filter((p) => p.team === TEAM.BLUE).length;
  if (redCount !== blueCount) {
    return fail("TEAM_BALANCE_REQUIRED", "Teams must have equal player counts.");
  }
  if (redCount < 4 || blueCount < 4) {
    return fail("NOT_ENOUGH_PLAYERS", "Each team must have at least 4 players.");
  }
  for (let i = 0; i < ordered.length; i += 1) {
    const next = ordered[(i + 1) % ordered.length];
    if (ordered[i].team === next.team) {
      return fail("ORDER_NOT_ALTERNATING", "Player order must alternate teams.");
    }
  }
  return ok();
}

function startGame() {
  const ordered = getOrderedPlayers();
  const shuffledNames = shuffle([...ordered.map((p) => p.nicknameRaw)]);
  for (let i = 0; i < ordered.length; i += 1) {
    ordered[i].assignedName = shuffledNames[i];
  }

  const seatCount = ordered.length + 1;
  const emptySeatIndex = randomInt(0, seatCount - 1);
  const couchStart = randomInt(0, seatCount - 1);
  const couchSeatIndices = [];
  for (let i = 0; i < 4; i += 1) {
    couchSeatIndices.push((couchStart + i) % seatCount);
  }

  const seats = Array(seatCount).fill(null);
  let cursor = 0;
  for (const player of ordered) {
    if (cursor === emptySeatIndex) {
      cursor += 1;
    }
    seats[cursor] = player.id;
    player.seatIndex = cursor;
    cursor += 1;
  }

  state.phase = PHASE.ACTIVE;
  state.seats = seats;
  state.emptySeatIndex = emptySeatIndex;
  state.couchSeatIndices = couchSeatIndices;
  state.currentCallerPlayerId = findNextOccupiedPlayerId(seats, emptySeatIndex);
  state.pendingMove = null;
  state.turnCount = 0;
  state.nameCooldowns = {};
  state.callableNameOrder = shuffle([...ordered.map((p) => p.nicknameRaw)]);
  state.winnerTeam = null;
}

function applyConfirmedMove(calledPlayer) {
  const oldSeatIndex = calledPlayer.seatIndex;
  const emptySeatIndex = state.emptySeatIndex;
  if (oldSeatIndex === null || oldSeatIndex === undefined) {
    throw new Error("Called player does not have a seat.");
  }
  if (oldSeatIndex === emptySeatIndex) {
    throw new Error("Invalid move state: called player already in empty seat.");
  }

  state.seats[emptySeatIndex] = calledPlayer.id;
  state.seats[oldSeatIndex] = null;
  calledPlayer.seatIndex = emptySeatIndex;
  state.emptySeatIndex = oldSeatIndex;

  decrementNameCooldowns();
  state.nameCooldowns[state.pendingMove.calledName] = NAME_COOLDOWN_TURNS;
  state.turnCount += 1;
  state.currentCallerPlayerId = findNextOccupiedPlayerId(state.seats, state.emptySeatIndex);
  state.pendingMove = null;

  const winnerTeam = getWinningTeam();
  if (winnerTeam) {
    state.phase = PHASE.FINISHED;
    state.winnerTeam = winnerTeam;
  }
}

function decrementNameCooldowns() {
  for (const [name, turns] of Object.entries(state.nameCooldowns)) {
    const next = Number(turns) - 1;
    if (next <= 0) {
      delete state.nameCooldowns[name];
    } else {
      state.nameCooldowns[name] = next;
    }
  }
}

function getWinningTeam() {
  if (!Array.isArray(state.couchSeatIndices) || !state.couchSeatIndices.length) {
    return null;
  }
  const seatPlayerIds = state.couchSeatIndices.map((index) => state.seats[index]);
  if (seatPlayerIds.some((id) => !id)) {
    return null;
  }
  const teams = seatPlayerIds.map((id) => getPlayerById(id)?.team || null);
  if (teams.some((team) => !team)) {
    return null;
  }
  const firstTeam = teams[0];
  return teams.every((team) => team === firstTeam) ? firstTeam : null;
}

function findNextOccupiedPlayerId(seats, fromEmptySeatIndex) {
  for (let offset = 1; offset <= seats.length; offset += 1) {
    const index = (fromEmptySeatIndex + offset) % seats.length;
    if (seats[index]) {
      return seats[index];
    }
  }
  return null;
}

function buildClientState(viewerPlayerId) {
  const ordered = getOrderedPlayers();
  const viewer = viewerPlayerId ? getPlayerById(viewerPlayerId) : null;
  const currentCaller = state.currentCallerPlayerId ? getPlayerById(state.currentCallerPlayerId) : null;
  const couchCounts = getCouchCounts();
  const nameTeamMap = {};
  for (const player of ordered) {
    nameTeamMap[player.nicknameRaw] = player.team;
  }
  const callableNameOrder = state.callableNameOrder.length
    ? state.callableNameOrder
    : ordered.map((p) => p.nicknameRaw);
  return {
    phase: state.phase,
    settings: {
      blindMode: Boolean(state.settings.blindMode),
      blindCouchMode: state.settings.blindCouchMode !== false
    },
    players: ordered.map((p) => ({
      id: p.id,
      nicknameRaw: p.nicknameRaw,
      team: p.team,
      order: p.order,
      isHost: p.isHost
    })),
    currentCallerPlayerId: state.currentCallerPlayerId,
    currentCallerName: currentCaller ? currentCaller.nicknameRaw : null,
    pendingMove: state.pendingMove
      ? {
          calledName: state.pendingMove.calledName,
          calledPlayerId: state.pendingMove.calledPlayerId,
          calledByPlayerId: state.pendingMove.calledByPlayerId
        }
      : null,
    canConfirmMove: Boolean(
      state.pendingMove && viewer && state.pendingMove.calledPlayerId === viewer.id && state.phase === PHASE.ACTIVE
    ),
    myAssignedName: viewer ? viewer.assignedName : null,
    callableNames: callableNameOrder.map((name) => ({
      name,
      cooldownTurnsRemaining: Number(state.nameCooldowns[name] || 0),
      team: nameTeamMap[name] || null
    })),
    couchCounts,
    turnCount: state.turnCount,
    winnerTeam: state.winnerTeam
  };
}

function getCouchCounts() {
  const counts = { RED: 0, BLUE: 0 };
  for (const seatIndex of state.couchSeatIndices) {
    const playerId = state.seats[seatIndex];
    const team = playerId ? getPlayerById(playerId)?.team : null;
    if (team === TEAM.RED || team === TEAM.BLUE) {
      counts[team] += 1;
    }
  }
  return counts;
}

function createInitialState() {
  return {
    phase: PHASE.LOBBY,
    settings: { ...DEFAULT_SETTINGS },
    players: [],
    seats: [],
    emptySeatIndex: null,
    couchSeatIndices: [],
    currentCallerPlayerId: null,
    pendingMove: null,
    turnCount: 0,
    nameCooldowns: {},
    callableNameOrder: [],
    winnerTeam: null
  };
}

function resetState() {
  const next = createInitialState();
  for (const key of Object.keys(state)) {
    state[key] = next[key];
  }
}

function getOrderedPlayers() {
  return [...state.players].sort((a, b) => a.order - b.order);
}

function getPlayerById(playerId) {
  return state.players.find((p) => p.id === playerId);
}

function ensureHost() {
  if (state.players.some((p) => p.isHost)) {
    return;
  }
  const ordered = getOrderedPlayers();
  if (ordered.length) {
    ordered[0].isHost = true;
  }
}

function normalizeNickname(value) {
  return value.toLowerCase().replace(/\s+/g, "");
}

function isValidTeam(team) {
  return team === TEAM.RED || team === TEAM.BLUE;
}

function getDefaultTeamForNewPlayer() {
  const ordered = getOrderedPlayers();
  if (!ordered.length) {
    return TEAM.RED;
  }
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const priorTeam = ordered[i].team;
    if (priorTeam === TEAM.RED) {
      return TEAM.BLUE;
    }
    if (priorTeam === TEAM.BLUE) {
      return TEAM.RED;
    }
  }
  return TEAM.RED;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function ok() {
  return { ok: true };
}

function fail(code, message) {
  return { ok: false, code, message };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Payload too large."));
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON payload."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store"
  });
  res.end(text);
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { ok: false, code: "FILE_NOT_FOUND", message: "File not found." });
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": data.length,
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

function serveStatic(pathname, res) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const resolved = path.resolve(PUBLIC_DIR, `.${safePath}`);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { ok: false, code: "FORBIDDEN", message: "Forbidden." });
  }
  const ext = path.extname(resolved).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };
  return sendFile(res, resolved, types[ext] || "application/octet-stream");
}

app.listen(PORT, () => {
  const hostIp = getPreferredLocalIpv4();
  const hostJoinUrl = `http://${hostIp}:${PORT}`;
  console.log(`Couch Game running on http://localhost:${PORT}`);
  console.log(`Join from same Wi-Fi: ${hostJoinUrl}`);
  startHelperServer(hostJoinUrl);
});

function getPreferredLocalIpv4() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const addr of addresses || []) {
      if (addr.family !== "IPv4" || addr.internal) {
        continue;
      }
      if (addr.address.startsWith("169.254.")) {
        continue;
      }
      const nameScore = /wi-?fi|wlan|wireless/i.test(name) ? 0 : 1;
      candidates.push({ nameScore, address: addr.address });
    }
  }
  candidates.sort((a, b) => a.nameScore - b.nameScore || a.address.localeCompare(b.address));
  return candidates[0]?.address || "127.0.0.1";
}

function startHelperServer(joinUrl) {
  const helper = http.createServer((req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host}`);
    if (parsed.pathname === "/helper-state" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, state: buildHelperState() });
    }
    if (parsed.pathname !== "/" || req.method !== "GET") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const html = buildHelperHtml(joinUrl);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(html)
    });
    res.end(html);
  });

  helper.listen(HELPER_PORT, () => {
    const helperUrl = `http://localhost:${HELPER_PORT}`;
    console.log(`Helper page opened at ${helperUrl}`);
    openUrl(helperUrl);
  });

  helper.on("error", (error) => {
    console.error(`Failed to start helper server on port ${HELPER_PORT}: ${error.message}`);
  });
}

function buildHelperState() {
  const currentCaller = state.currentCallerPlayerId ? getPlayerById(state.currentCallerPlayerId) : null;
  return {
    phase: state.phase,
    blindMode: state.settings.blindMode,
    blindCouchMode: state.settings.blindCouchMode !== false,
    currentCallerName: currentCaller ? currentCaller.nicknameRaw : null,
    pendingCalledName: state.pendingMove ? state.pendingMove.calledName : null,
    callableNames: (state.callableNameOrder.length
      ? state.callableNameOrder
      : getOrderedPlayers().map((p) => p.nicknameRaw)
    ).map((name) => {
      const owner = state.players.find((p) => p.nicknameRaw === name);
      return {
        name,
        cooldownTurnsRemaining: Number(state.nameCooldowns[name] || 0),
        team: owner ? owner.team : null
      };
    }),
    couchCounts: getCouchCounts(),
    winnerTeam: state.winnerTeam
  };
}

function buildHelperHtml(joinUrl) {
  const escapedJoinUrl = joinUrl.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(joinUrl)}`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Couch Game Helper</title>
    <style>
      :root { font-family: Inter, Segoe UI, Arial, sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; background: #111924; color: #f3f7ff; }
      main { max-width: 860px; margin: 0 auto; padding: 18px; display: grid; gap: 12px; }
      .card { background: #1c2634; border: 1px solid #334255; border-radius: 12px; padding: 14px; }
      .header { display: grid; grid-template-columns: auto 1fr; gap: 14px; align-items: center; }
      img { width: 180px; background: #fff; border-radius: 10px; padding: 8px; }
      code { display: block; margin-top: 10px; background: #101722; border-radius: 8px; padding: 8px; color: #a3c8ff; }
      .meta { font-size: 1.05rem; font-weight: 700; }
      .scores { display: flex; gap: 8px; }
      .score { padding: 8px 10px; border-radius: 8px; font-weight: 800; }
      .red { background: #6f2626; }
      .blue { background: #284a8a; }
      ul { margin: 0; padding-left: 18px; display: grid; gap: 6px; }
      .cooldown { opacity: 0.55; text-decoration: line-through; }
      .pill { display: inline-block; min-width: 24px; text-align: center; margin-left: 6px; border-radius: 99px; background: #3e4d61; padding: 2px 7px; font-size: 0.82rem; }
    </style>
  </head>
  <body>
    <main>
      <section class="card header">
        <img src="${qrSrc}" alt="Join QR code" />
        <div>
          <h1 style="margin:0">Couch Game Helper</h1>
          <p id="meta" class="meta">Waiting to start.</p>
          <div id="scores" class="scores">
            <div class="score red">Red couch: <span id="redCount">0</span>/4</div>
            <div class="score blue">Blue couch: <span id="blueCount">0</span>/4</div>
          </div>
          <code>${escapedJoinUrl}</code>
        </div>
      </section>
      <section class="card">
        <h2 style="margin-top:0">Callable Names</h2>
        <ul id="nameList"></ul>
      </section>
    </main>
    <script>
      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#039;");
      }
      async function refresh() {
        try {
          const response = await fetch('/helper-state', { cache: 'no-store' });
          if (!response.ok) return;
          const data = await response.json();
          if (!data.ok) return;
          const s = data.state;
          const meta = document.getElementById('meta');
          const scores = document.getElementById('scores');
          const redCount = document.getElementById('redCount');
          const blueCount = document.getElementById('blueCount');
          if (s.blindCouchMode) {
            scores.style.display = 'none';
          } else {
            scores.style.display = 'flex';
            redCount.textContent = String(s.couchCounts?.RED ?? 0);
            blueCount.textContent = String(s.couchCounts?.BLUE ?? 0);
          }
          if (s.phase === 'FINISHED' && s.winnerTeam) {
            meta.textContent = s.winnerTeam + ' wins!';
          } else if (s.phase === 'ACTIVE') {
            const caller = s.currentCallerName || 'Unknown';
            if (s.pendingCalledName) {
              meta.textContent = caller + ' called "' + s.pendingCalledName + '" - waiting for move confirmation.';
            } else {
              meta.textContent = 'Current caller: ' + caller;
            }
          } else {
            meta.textContent = 'Lobby phase: waiting to start.';
          }
          const nameList = document.getElementById('nameList');
          nameList.innerHTML = '';
          for (const entry of s.callableNames || []) {
            const li = document.createElement('li');
            if (!s.blindMode) {
              if (entry.team === 'RED') li.style.color = '#ff9f9f';
              if (entry.team === 'BLUE') li.style.color = '#9fc3ff';
            }
            if (entry.cooldownTurnsRemaining > 0) {
              li.classList.add('cooldown');
              li.innerHTML = escapeHtml(entry.name) + ' <span class="pill">' + entry.cooldownTurnsRemaining + '</span>';
            } else {
              li.textContent = entry.name;
            }
            nameList.appendChild(li);
          }
        } catch {}
      }
      refresh();
      setInterval(refresh, 700);
    </script>
  </body>
</html>`;
}

function openUrl(url) {
  const escapedUrl = `"${url}"`;
  if (process.platform === "win32") {
    exec(`start "" ${escapedUrl}`, { shell: "cmd.exe" }, () => {});
    return;
  }
  if (process.platform === "darwin") {
    exec(`open ${escapedUrl}`, () => {});
    return;
  }
  exec(`xdg-open ${escapedUrl}`, () => {});
}
