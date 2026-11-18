# Couch Game Spec

## 1. Scope

This spec defines the first playable version of **Couch Game** as a local LAN web app with a host helper/QR page, inspired by Fishbowl’s architecture and multiplayer flow.

This document covers only product/game behavior and UI/UX decisions, not implementation details.

## 2. Core game constraints

- Exactly **2 teams**, with **equal team sizes**.
- Minimum total players: **8** (so each team has at least 4 players).
- Total players must be an even number (`>= 8`).

## 3. Physical seat model

- Seats are represented as a **circular list** (first and last are neighbors).
- Total seat count = player count + 1.
- There is always exactly **one empty seat**.
- At game setup:
  - Empty seat index is chosen randomly.
  - A target **couch block** of 4 contiguous seats is chosen randomly on the same circle.
  - Empty seat may be inside the couch block.

## 4. Win condition

A team wins immediately when all 4 seats in the couch block are occupied by players from that same team.

## 5. Hidden name assignment

At game start:
- Player nicknames are shuffled and secretly assigned 1:1 as each player’s **assigned name**.
- Assigned names are fixed for the whole game.
- A player may receive their own nickname.
- Only that player can see their assigned name by default.

## 6. Turn and move flow

Each turn:
1. Current caller selects one nickname from the callable-name list and submits it.
2. The player currently holding that assigned name must move to the empty seat.
3. Called player confirms “move completed.”
4. Empty seat updates to the seat vacated by that moving player.
5. Next caller becomes the player immediately **clockwise from the new empty seat**.
6. Evaluate win condition.

## 7. Name calling cooldown

- Cooldown is global per nickname.
- After a nickname is called, it cannot be called again for **3 completed turns** (3 call+move completions).
- UI must block submission for names on cooldown.
- Cooldown labels should display remaining turns (e.g., `2`, `1`).

## 8. Lobby and setup settings

Pre-game lobby includes:
- Team assignment / balancing with required alternation constraints for play order if needed by host tooling.
- Start game action.
- **Blind mode** toggle (default: off):
  - **Off**: nickname list entries are color-coded by owning player’s team.
  - **On**: no team color coding on nickname list.

## 9. Visibility rules

### Player UI

Must show:
- Current turn caller.
- Callable nickname list with cooldown visuals:
  - cooldown names are struck-through/faded + remaining-turn number.
- Player’s own assigned secret name:
  - hidden by default,
  - reveal only while press-and-hold,
  - re-censor when released.

### Host helper / QR page

Must show:
- Join QR and LAN URL.
- Current turn caller.
- Callable nickname list with same cooldown state.
- Team scores/status if tracked.
- Team-color presenter/turn accents when not in blind mode.

## 10. Callable name list ordering

- The visible nickname list must **not** imply seating order.
- Backend keeps true seat order privately for rule evaluation.
- UI list should use a non-seat ordering (recommended: fixed randomized display order per game).

## 11. Validation and rule enforcement

- Game start requires valid player count and equal teams.
- Calling a cooldowned nickname is rejected.
- Move confirmation must come from the called player identity.
- Seat updates and next-turn ownership derive only from server-side seat state.

## 12. Suggested state model (conceptual)

- `players[]`: id, nickname, team, assignedName, seatIndex
- `settings`: blindMode
- `seats[]`: playerId | empty
- `emptySeatIndex`
- `couchSeatIndices[4]`
- `currentCallerPlayerId`
- `calledName`
- `pendingMoverPlayerId`
- `nameCooldowns`: map nickname -> turnsRemaining
- `phase`: lobby | active | finished
- `winnerTeam`

## 13. Non-goals (v1)

- Timers/turn countdowns.
- AI or auto-move adjudication.
- Complex moderation/admin controls beyond host start/reset.
