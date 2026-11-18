const PHASE = {
  LOBBY: "LOBBY",
  ACTIVE: "ACTIVE",
  FINISHED: "FINISHED"
};

const TEAM = {
  RED: "RED",
  BLUE: "BLUE"
};

const STORAGE_KEYS = {
  playerId: "couch_player_id",
  nicknameRaw: "couch_nickname_raw"
};

let gameState = null;
let selectedPlayerForOrder = null;
let pollTimer = null;
let holdRevealActive = false;

const els = {
  connectionStatus: byId("connectionStatus"),
  alerts: byId("alerts"),
  joinView: byId("joinView"),
  nicknameInput: byId("nicknameInput"),
  joinBtn: byId("joinBtn"),
  lobbyView: byId("lobbyView"),
  hostBadge: byId("hostBadge"),
  blindModeCheckbox: byId("blindModeCheckbox"),
  blindCouchModeCheckbox: byId("blindCouchModeCheckbox"),
  saveSettingsBtn: byId("saveSettingsBtn"),
  playersList: byId("playersList"),
  moveUpBtn: byId("moveUpBtn"),
  moveDownBtn: byId("moveDownBtn"),
  startGameBtn: byId("startGameBtn"),
  gameView: byId("gameView"),
  phaseLabel: byId("phaseLabel"),
  callerText: byId("callerText"),
  pendingText: byId("pendingText"),
  couchCounts: byId("couchCounts"),
  redCouchCount: byId("redCouchCount"),
  blueCouchCount: byId("blueCouchCount"),
  assignedNameBlock: byId("assignedNameBlock"),
  assignedNameValue: byId("assignedNameValue"),
  holdRevealBtn: byId("holdRevealBtn"),
  callControls: byId("callControls"),
  nameButtons: byId("nameButtons"),
  confirmMoveBlock: byId("confirmMoveBlock"),
  confirmMoveBtn: byId("confirmMoveBtn"),
  nameList: byId("nameList"),
  finishedView: byId("finishedView"),
  winnerText: byId("winnerText"),
  endGameBtn: byId("endGameBtn")
};

els.nicknameInput.value = localStorage.getItem(STORAGE_KEYS.nicknameRaw) || "";
startPolling();

els.joinBtn.addEventListener("click", async () => {
  const nicknameRaw = els.nicknameInput.value.trim();
  if (!nicknameRaw) {
    setAlert("Enter a nickname.");
    return;
  }
  let playerId = localStorage.getItem(STORAGE_KEYS.playerId);
  if (!playerId) {
    playerId = createId();
  }
  const result = await apiJoin({ playerId, nicknameRaw });
  if (!result.ok) {
    setAlert(result.message || "Failed to join.");
    return;
  }
  localStorage.setItem(STORAGE_KEYS.playerId, result.playerId);
  localStorage.setItem(STORAGE_KEYS.nicknameRaw, nicknameRaw);
  gameState = result.state;
  render();
});

els.saveSettingsBtn.addEventListener("click", () =>
  sendAction({
    type: "UPDATE_SETTINGS",
    blindMode: Boolean(els.blindModeCheckbox.checked),
    blindCouchMode: Boolean(els.blindCouchModeCheckbox.checked)
  })
);
els.moveUpBtn.addEventListener("click", () => reorderSelected(-1));
els.moveDownBtn.addEventListener("click", () => reorderSelected(1));
els.startGameBtn.addEventListener("click", () => sendAction({ type: "START_GAME" }));
els.confirmMoveBtn.addEventListener("click", () => sendAction({ type: "CONFIRM_MOVE" }));
els.endGameBtn.addEventListener("click", () => sendAction({ type: "END_GAME" }));

els.holdRevealBtn.addEventListener("pointerdown", () => {
  holdRevealActive = true;
  renderAssignedName();
});
els.holdRevealBtn.addEventListener("pointerup", () => {
  holdRevealActive = false;
  renderAssignedName();
});
els.holdRevealBtn.addEventListener("pointercancel", () => {
  holdRevealActive = false;
  renderAssignedName();
});
els.holdRevealBtn.addEventListener("pointerleave", () => {
  holdRevealActive = false;
  renderAssignedName();
});

async function startPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
  }
  await refreshState();
  pollTimer = setInterval(refreshState, 700);
}

async function refreshState() {
  const playerId = localStorage.getItem(STORAGE_KEYS.playerId) || "";
  try {
    const result = await fetch(`/api/state?playerId=${encodeURIComponent(playerId)}`, { cache: "no-store" });
    if (!result.ok) {
      els.connectionStatus.textContent = "Offline";
      return;
    }
    const data = await result.json();
    if (!data.ok) {
      return;
    }
    els.connectionStatus.textContent = "Connected";
    gameState = data.state;
    render();
  } catch {
    els.connectionStatus.textContent = "Offline";
  }
}

async function apiJoin(payload) {
  try {
    const result = await fetch("/api/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return await result.json();
  } catch {
    return { ok: false, message: "Join failed." };
  }
}

async function sendAction(payload) {
  const playerId = localStorage.getItem(STORAGE_KEYS.playerId) || "";
  try {
    const result = await fetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, playerId })
    });
    const data = await result.json();
    if (!data.ok) {
      if (data.code === "UNKNOWN_PLAYER") {
        const rejoined = await tryRejoinFromSavedNickname();
        if (rejoined) {
          return sendAction(payload);
        }
      }
      setAlert(data.message || "Action failed.");
      return false;
    }
    gameState = data.state;
    render();
    return true;
  } catch {
    setAlert("Action failed.");
    return false;
  }
}

async function tryRejoinFromSavedNickname() {
  const nicknameRaw = (localStorage.getItem(STORAGE_KEYS.nicknameRaw) || "").trim();
  if (!nicknameRaw) {
    return false;
  }
  const existingPlayerId = localStorage.getItem(STORAGE_KEYS.playerId) || createId();
  const result = await apiJoin({ playerId: existingPlayerId, nicknameRaw });
  if (!result.ok) {
    return false;
  }
  localStorage.setItem(STORAGE_KEYS.playerId, result.playerId);
  localStorage.setItem(STORAGE_KEYS.nicknameRaw, nicknameRaw);
  gameState = result.state;
  render();
  return true;
}

function render() {
  if (!gameState) {
    return;
  }
  const me = getMe();
  const isJoined = Boolean(me);
  const isHost = Boolean(me?.isHost);

  toggle(els.joinView, !isJoined);
  toggle(els.lobbyView, isJoined && gameState.phase === PHASE.LOBBY);
  toggle(els.gameView, isJoined && gameState.phase === PHASE.ACTIVE);
  toggle(els.finishedView, isJoined && gameState.phase === PHASE.FINISHED);
  toggle(els.hostBadge, isHost);

  if (!isJoined) {
    return;
  }

  if (gameState.phase === PHASE.LOBBY) {
    renderLobby(me, isHost);
  }
  if (gameState.phase === PHASE.ACTIVE) {
    renderGame(me);
  }
  if (gameState.phase === PHASE.FINISHED) {
    els.winnerText.textContent = gameState.winnerTeam
      ? `${gameState.winnerTeam} team wins the couch!`
      : "Game ended.";
  }
}

function renderLobby(me, isHost) {
  els.blindModeCheckbox.checked = Boolean(gameState.settings.blindMode);
  els.blindCouchModeCheckbox.checked = gameState.settings.blindCouchMode !== false;
  els.playersList.innerHTML = "";
  for (const player of gameState.players) {
    const row = document.createElement("div");
    row.className = "player-row";
    row.dataset.playerId = player.id;
    row.addEventListener("click", () => {
      selectedPlayerForOrder = player.id;
      highlightSelection();
    });

    const orderCell = document.createElement("div");
    orderCell.textContent = `#${player.order + 1}`;
    const nameCell = document.createElement("div");
    nameCell.textContent = player.nicknameRaw;
    const teamCell = document.createElement("div");
    if (player.id === me.id) {
      const select = document.createElement("select");
      select.innerHTML = '<option value="RED">RED</option><option value="BLUE">BLUE</option>';
      select.value = player.team || TEAM.RED;
      select.addEventListener("change", () => {
        sendAction({ type: "SET_TEAM", team: select.value });
      });
      teamCell.appendChild(select);
    } else {
      teamCell.textContent = player.team || "NO TEAM";
      teamCell.className = player.team === TEAM.RED ? "red" : player.team === TEAM.BLUE ? "blue" : "";
    }
    const hostCell = document.createElement("div");
    hostCell.textContent = player.isHost ? "Host" : "";

    row.appendChild(orderCell);
    row.appendChild(nameCell);
    row.appendChild(teamCell);
    row.appendChild(hostCell);
    els.playersList.appendChild(row);
  }
  highlightSelection();
  toggle(els.moveUpBtn, isHost);
  toggle(els.moveDownBtn, isHost);
  toggle(els.startGameBtn, isHost);
  toggle(els.saveSettingsBtn, isHost);
}

function renderGame(me) {
  els.phaseLabel.textContent = "Active Game";
  els.callerText.textContent = `Current caller: ${gameState.currentCallerName || "Unknown"}`;
  els.pendingText.textContent = gameState.pendingMove
    ? `Called name: ${gameState.pendingMove.calledName}`
    : "No pending move.";
  els.redCouchCount.textContent = String(gameState.couchCounts?.RED ?? 0);
  els.blueCouchCount.textContent = String(gameState.couchCounts?.BLUE ?? 0);
  const blindCouchMode = gameState.settings.blindCouchMode !== false;
  toggle(els.couchCounts, !blindCouchMode);

  toggle(els.assignedNameBlock, Boolean(gameState.myAssignedName));
  renderAssignedName();

  const myTurn = gameState.currentCallerPlayerId === me.id && !gameState.pendingMove;
  toggle(els.callControls, myTurn);
  renderNameButtons(myTurn);

  toggle(els.confirmMoveBlock, Boolean(gameState.canConfirmMove));
  renderNameList();
}

function renderAssignedName() {
  if (!gameState?.myAssignedName) {
    return;
  }
  els.assignedNameValue.textContent = holdRevealActive ? gameState.myAssignedName : "••••••••";
}

function renderNameButtons(myTurn) {
  els.nameButtons.innerHTML = "";
  if (!myTurn) {
    return;
  }
  for (const entry of gameState.callableNames || []) {
    const btn = document.createElement("button");
    btn.className = "name-btn";
    btn.textContent =
      entry.cooldownTurnsRemaining > 0 ? `${entry.name} (${entry.cooldownTurnsRemaining})` : entry.name;
    if (!gameState.settings.blindMode) {
      if (entry.team === TEAM.RED) {
        btn.style.color = "#ffb1b1";
      } else if (entry.team === TEAM.BLUE) {
        btn.style.color = "#b1ccff";
      }
    }
    if (entry.cooldownTurnsRemaining > 0) {
      btn.disabled = true;
      btn.classList.add("cooldown");
    }
    btn.addEventListener("click", () => {
      sendAction({ type: "CALL_NAME", calledName: entry.name });
    });
    els.nameButtons.appendChild(btn);
  }
}

function renderNameList() {
  els.nameList.innerHTML = "";
  for (const entry of gameState.callableNames || []) {
    const row = document.createElement("div");
    row.className = "name-row";
    if (!gameState.settings.blindMode) {
      if (entry.team === TEAM.RED) {
        row.classList.add("red");
      } else if (entry.team === TEAM.BLUE) {
        row.classList.add("blue");
      }
    }
    if (entry.cooldownTurnsRemaining > 0) {
      row.classList.add("cooldown");
      row.innerHTML = `${escapeHtml(entry.name)} <span class="pill-small">${entry.cooldownTurnsRemaining}</span>`;
    } else {
      row.textContent = entry.name;
    }
    els.nameList.appendChild(row);
  }
}

function reorderSelected(direction) {
  if (!gameState || !selectedPlayerForOrder) {
    return;
  }
  const players = [...gameState.players];
  const idx = players.findIndex((p) => p.id === selectedPlayerForOrder);
  if (idx < 0) {
    return;
  }
  const next = idx + direction;
  if (next < 0 || next >= players.length) {
    return;
  }
  [players[idx], players[next]] = [players[next], players[idx]];
  sendAction({ type: "REORDER_PLAYERS", orderedPlayerIds: players.map((p) => p.id) });
}

function highlightSelection() {
  for (const row of els.playersList.querySelectorAll(".player-row")) {
    row.style.outline = row.dataset.playerId === selectedPlayerForOrder ? "2px solid #89a7d8" : "";
  }
}

function getMe() {
  if (!gameState) {
    return null;
  }
  const playerId = localStorage.getItem(STORAGE_KEYS.playerId);
  if (!playerId) {
    return null;
  }
  return gameState.players.find((player) => player.id === playerId) || null;
}

function setAlert(message) {
  els.alerts.innerHTML = `<div class="alert">${escapeHtml(message)}</div>`;
  setTimeout(() => {
    if (els.alerts.textContent === message) {
      els.alerts.innerHTML = "";
    }
  }, 3500);
}

function toggle(el, show) {
  el.classList.toggle("hidden", !show);
}

function byId(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function createId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex
      .slice(8, 10)
      .join("")}-${hex.slice(10, 16).join("")}`;
  }
  return `player-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
