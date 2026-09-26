const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 3000);
const GAME_FILE = path.join(__dirname, "maze_horde_tactical_operations (3).html");
const MAX_PLAYERS = 2;
const MAX_CUBES = 5;
const START_FREEZE_MS = 8000;
const CAPTURE_DISTANCE = 4.5;
const STATE_UPDATE_INTERVAL_MS = 50;
const lobbies = new Map();

function makeId() {
  return crypto.randomBytes(12).toString("hex");
}

function makeSeed() {
  return crypto.randomInt(1, 0x7fffffff);
}

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
  } while (lobbies.has(code));
  return code;
}

function initialState(x, z) {
  return { x, z, r: 0, scanTrigger: 0, captured: false, cubesCollected: 0 };
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function send(ws, message) {
  if (ws.readyState === 1) ws.send(JSON.stringify(message));
}

function playerEntries(lobby) {
  return Object.entries(lobby.players);
}

function findPlayerBySlot(lobby, slot) {
  return playerEntries(lobby).find(([, player]) => player.slot === slot);
}

function publicLobby(lobby) {
  const players = {};
  for (const [id, player] of playerEntries(lobby)) {
    players[id] = {
      name: player.name,
      ready: player.ready,
      role: player.role,
      slot: player.slot,
    };
  }

  return {
    code: lobby.code,
    hostId: lobby.hostId,
    seed: lobby.seed,
    status: lobby.status,
    createdAt: lobby.createdAt,
    cubeCount: lobby.cubeCount,
    winner: lobby.winner,
    players,
    state: lobby.state,
  };
}

function broadcastLobby(lobby) {
  const snapshot = { type: "lobby", lobby: publicLobby(lobby) };
  for (const [, player] of playerEntries(lobby)) send(player.ws, snapshot);
}

function error(ws, message) {
  send(ws, { type: "error", message });
}

function closeLobby(lobby) {
  lobbies.delete(lobby.code);
  for (const [, player] of playerEntries(lobby)) {
    player.ws.lobbyCode = null;
    send(player.ws, { type: "error", message: "Lobby closed by host" });
  }
}

function finishLobby(lobby, winner) {
  if (lobby.status !== "playing") return;
  lobby.status = "finished";
  lobby.winner = winner;
  for (const [, player] of playerEntries(lobby)) {
    send(player.ws, { type: "game-over", winner });
  }
  broadcastLobby(lobby);
}

function checkCapture(lobby) {
  if (lobby.status !== "playing" || Date.now() - lobby.startedAt < START_FREEZE_MS) return;
  const seeker = playerEntries(lobby).find(([, player]) => player.role === "seeker");
  const hider = playerEntries(lobby).find(([, player]) => player.role === "hider");
  if (!seeker || !hider) return;

  const seekerState = lobby.state[seeker[1].slot];
  const hiderState = lobby.state[hider[1].slot];
  if (!seekerState || !hiderState) return;

  const distance = Math.hypot(seekerState.x - hiderState.x, seekerState.z - hiderState.z);
  if (distance <= CAPTURE_DISTANCE) finishLobby(lobby, "seeker");
}

function handleMessage(ws, message) {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "create") {
    if (ws.lobbyCode) {
      const oldLobby = lobbies.get(ws.lobbyCode);
      if (oldLobby) closeLobby(oldLobby);
    }

    const preferredRole = ["seeker", "hider"].includes(message.preferredRole)
      ? message.preferredRole
      : crypto.randomInt(2) === 0 ? "seeker" : "hider";
    const code = makeCode();
    const lobby = {
      code,
      hostId: ws.playerId,
      seed: makeSeed(),
      status: "waiting",
      createdAt: Date.now(),
      startedAt: 0,
      cubeCount: 0,
      winner: null,
      players: {
        [ws.playerId]: {
          name: "HOST (P1)",
          ready: false,
          role: preferredRole,
          slot: "p1",
          ws,
          lastCollectAt: 0,
          lastStateAt: 0,
        },
      },
      state: { p1: initialState(0, -15), p2: null },
    };
    lobbies.set(code, lobby);
    ws.lobbyCode = code;
    send(ws, { type: "lobby", lobby: publicLobby(lobby) });
    return;
  }

  if (message.type === "join") {
    const code = String(message.code || "").toUpperCase();
    const lobby = lobbies.get(code);
    if (!lobby) return error(ws, "Lobby not found");
    if (lobby.status !== "waiting") return error(ws, "Match already in progress");
    if (playerEntries(lobby).length >= MAX_PLAYERS && !lobby.players[ws.playerId]) {
      return error(ws, "Lobby is full");
    }

    if (!lobby.players[ws.playerId]) {
      const host = findPlayerBySlot(lobby, "p1");
      const role = host[1].role === "seeker" ? "hider" : "seeker";
      lobby.players[ws.playerId] = {
        name: "PLAYER 2",
        ready: false,
        role,
        slot: "p2",
        ws,
        lastCollectAt: 0,
        lastStateAt: 0,
      };
      lobby.state.p2 = initialState(0, 15);
    }
    ws.lobbyCode = code;
    broadcastLobby(lobby);
    return;
  }

  if (message.type === "list") {
    const openLobbies = Array.from(lobbies.values())
      .filter((lobby) => lobby.status === "waiting" && playerEntries(lobby).length < MAX_PLAYERS)
      .map((lobby) => ({
        code: lobby.code,
        playerCount: playerEntries(lobby).length,
        createdAt: lobby.createdAt,
      }));
    return send(ws, { type: "browser", lobbies: openLobbies });
  }

  const lobby = ws.lobbyCode ? lobbies.get(ws.lobbyCode) : null;
  if (!lobby || !lobby.players[ws.playerId]) return error(ws, "Join a lobby first");
  const player = lobby.players[ws.playerId];

  if (message.type === "ready") {
    if (lobby.status !== "waiting") return;
    player.ready = Boolean(message.ready);
    broadcastLobby(lobby);
    return;
  }

  if (message.type === "start") {
    if (ws.playerId !== lobby.hostId) return error(ws, "Only the host can start the match");
    const players = playerEntries(lobby);
    if (players.length !== MAX_PLAYERS || !players.every(([, item]) => item.ready)) {
      return error(ws, "Both players must be ready");
    }
    const roles = players.map(([, item]) => item.role);
    if (new Set(roles).size !== MAX_PLAYERS || !roles.includes("seeker") || !roles.includes("hider")) {
      return error(ws, "Match must have exactly one seeker and one hider");
    }
    lobby.status = "playing";
    lobby.startedAt = Date.now();
    broadcastLobby(lobby);
    return;
  }

  if (message.type === "state") {
    if (lobby.status !== "playing" || !message.state) return;
    const now = Date.now();
    if (now - player.lastStateAt < STATE_UPDATE_INTERVAL_MS) return;
    player.lastStateAt = now;

    const state = message.state;
    const previousState = lobby.state[player.slot] || initialState(0, 0);
    const nextState = {
      x: clamp(finiteNumber(state.x, previousState.x), -490, 490),
      z: clamp(finiteNumber(state.z, previousState.z), -490, 490),
      r: finiteNumber(state.r, previousState.r),
      scanTrigger: finiteNumber(state.scanTrigger, previousState.scanTrigger),
      captured: false,
      cubesCollected: lobby.cubeCount,
    };
    lobby.state[player.slot] = nextState;
    for (const [id, other] of playerEntries(lobby)) {
      if (id !== ws.playerId) send(other.ws, { type: "state", slot: player.slot, state: nextState });
    }
    checkCapture(lobby);
    return;
  }

  if (message.type === "scan") {
    if (lobby.status !== "playing") return;
    for (const [id, other] of playerEntries(lobby)) {
      if (id !== ws.playerId) send(other.ws, { type: "scan", timestamp: Number(message.timestamp) || Date.now() });
    }
    return;
  }

  if (message.type === "collect") {
    if (lobby.status !== "playing" || player.role !== "hider") return;
    const requestedCount = Number(message.count);
    if (!Number.isInteger(requestedCount) || requestedCount < 1 || requestedCount > MAX_CUBES) return;
    if (requestedCount !== lobby.cubeCount + 1) return;
    if (Date.now() - player.lastCollectAt < 500) return;
    player.lastCollectAt = Date.now();
    lobby.cubeCount = requestedCount;
    for (const [, peer] of playerEntries(lobby)) send(peer.ws, { type: "cubes", count: lobby.cubeCount });
    if (lobby.cubeCount >= MAX_CUBES) finishLobby(lobby, "hider");
    return;
  }

  if (message.type === "leave") removePlayer(ws);
}

function removePlayer(ws) {
  const code = ws.lobbyCode;
  const lobby = code ? lobbies.get(code) : null;
  if (!lobby) return;

  if (ws.playerId === lobby.hostId) {
    closeLobby(lobby);
    return;
  }

  delete lobby.players[ws.playerId];
  lobby.state.p2 = null;
  lobby.status = "waiting";
  lobby.startedAt = 0;
  lobby.cubeCount = 0;
  ws.lobbyCode = null;
  broadcastLobby(lobby);
}

const server = http.createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, lobbies: lobbies.size }));
    return;
  }

  if (request.url !== "/" && request.url !== "/index.html") {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  fs.readFile(GAME_FILE, (readError, content) => {
    if (readError) {
      response.writeHead(500);
      response.end("Game file unavailable");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(content);
  });
});

const webSocketServer = new WebSocketServer({ server });
webSocketServer.on("connection", (ws) => {
  ws.playerId = makeId();
  ws.lobbyCode = null;
  send(ws, { type: "hello", playerId: ws.playerId });
  ws.on("message", (data) => {
    try {
      handleMessage(ws, JSON.parse(data.toString()));
    } catch {
      error(ws, "Invalid network message");
    }
  });
  ws.on("close", () => removePlayer(ws));
});

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const lobby of lobbies.values()) {
    if (lobby.createdAt < cutoff && lobby.status !== "playing") closeLobby(lobby);
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Maze Horde match server listening on port ${PORT}`);
});