# src/protocol/

## OVERVIEW
Legacy Spring lobby protocol as BAR's Teiserver speaks it: plaintext TCP (no TLS) to `server4.beyondallreason.info:8200`; pure parsers/builders, no I/O.

## WHERE TO LOOK
| Need | File |
|------|------|
| Line splitting, words vs TAB sentences | `framing.ts` (`parseMessage`, `LineBuffer`) |
| Outbound lines (LOGIN, JOINBATTLE, MYBATTLESTATUS, force-moves, chat, friends) | `commands.ts` |
| Typed inbound extractors | `events.ts` |
| Per-battle status int (MYBATTLESTATUS / CLIENTBATTLESTATUS) | `battleStatus.ts` |
| Global per-user status int (CLIENTSTATUS / MYSTATUS) | `clientStatus.ts` |
| Spec + Teiserver source pointers | `docs/protocol/PROTOCOL.md` (Teiserver `spring_in.ex` / `spring_out.ex` win over the spec) |
| Caller (LOGIN, join, dispatch) | `src/bot/bot.ts` |
| Live check against the real server | `tools/connect-test.ts` |

## CONVENTIONS
- Framing: one `\n`-terminated line; `\r` stripped. Before the first TAB = space-split `words` (cmd upper-cased); after = TAB-split `sentences`. Builders return lines WITHOUT `\n`.
- Handshake: server sends `TASSERVER`, client replies `LOGIN`.
- LOGIN: `LOGIN <user> <base64(md5(pass))> 0 * <lobbyName>\t<lobby_hash>\t<flags>` (Teiserver regex `^(\S+) (\S+) (0) ([0-9\.\*]+) ([^\t]+)?\t?([^\t]+)?\t?([^\t]+)?`).
  - cpu must be literal `0`; ip `*`.
  - `LoginParams.userId` IS the lobby_hash field. Must be non-empty and not `0` ("LobbyHash/UserID missing in login"). Bot sends `"<md5hex(user)> <md5hex(user+"|sys")[:16]>"` (same as connect-test). Untrusted, smurf grouping only.
  - flags `b sp`. lobbyName is self-declared (`lavabalance-bot 0.1.0`), becomes `lobby_client` in ADDUSER; not auth.
- Password: `base64(md5(pass))` (Teiserver `try_md5_login`); stored pre-hashed, never hashed in the Worker (WebCrypto lacks MD5).
- JOINBATTLE needs exactly 3 args: `JOINBATTLE <id> <password> <scriptPassword>`; `empty` = no password. Bare `JOINBATTLE <id>` is dropped with SERVERMSG "No incomming match". Success reply is `JOINBATTLE`; failure `JOINBATTLEFAILED`.
- Battle status bits: 1 ready; 2-5 team low nibble; 6-9 ally low nibble; 10 mode (1 player, 0 spectator); 11-17 handicap; 18-21 team high nibble; 22-23 sync (0 unknown, 1 synced, 2 unsynced = usually downloading map); 24-27 side; 28-31 ally high nibble.
  - team/ally are 8-bit split across two nibbles; 16v16 has numbers > 15, so always reassemble both.
  - ally high nibble reaches bit 31 → encode with `>>> 0`, decode with `>>>` only.
  - Spectate = `MYBATTLESTATUS` with bit 10 clear (`SPECTATOR_STATUS`, claims sync=1).
- CLIENTSTATUS `<user> <status>`: global, not battle-scoped. b0 in-game, b1 away, b2-4 rank, b5 access/mod, b6 bot. `rank` is exposed as 1-8 display level (`bits + 1`, Chobby convention) = `ranks/<n>.png`.
- ADDUSER `<name> <country> <accountid> <lobby_client>`.
- BATTLEOPENED: head words end with `engineName` (`words[10]`); engineVersion, map, title, gameName, channel are TAB sentences.
- UPDATEBATTLEINFO `<id> <specs> <locked> <mapHash> <mapName>`: mapName is the space-joined `words.slice(4)` (no TAB on the wire).
- `s.battle.update_lobby_title <id>\t<title>`: routes by id; cmd arrives upper-cased as `S.BATTLE.UPDATE_LOBBY_TITLE`.
- SETSCRIPTTAGS: TAB-separated `key=value`, keys lowercased by server; first pair is in `words` (value may contain spaces). Used: `game/players/<name>/skill` (`[12.81]` → number), `game/modoptions/<name>`.
- No battle id on CLIENTBATTLESTATUS, SETSCRIPTTAGS, REMOVESCRIPTTAGS, SAIDBATTLEEX → caller routes to the bot's current battle.
- SAIDBATTLEEX may carry `* BarManager|<json>`; single top-level key = event type.
- Friends: `ACCEPTFRIENDREQUEST userName=<name>`; list reply is `FRIENDREQUESTLISTBEGIN` / `FRIENDREQUESTLIST userName=<name>`… / `FRIENDREQUESTLISTEND`.
- One user = one battle; duplicate logins rejected → one bot account per room.

## ANTI-PATTERNS
- TLS / STLS upgrade: removed; connect plaintext (`secureTransport: "off"` in the Worker).
- Relying on `login()`'s default `userId = "0"`: Teiserver rejects it.
- Signed shifts (`>>`) when decoding battle status: ally ≥ 128 sets the sign bit (`parseClientBattleStatus` yields a signed int; `decodeBattleStatus` re-normalizes with `>>> 0`).
- Reading only the low nibble of team/ally.
- Reading UPDATEBATTLEINFO mapName from `sentences[0]` (empty on the wire; dropped every map name).
- Sending `!force` / SPADS commands via `sayBattleEx`: SPADS ignores SAIDBATTLEEX; use `sayBattle`.
- Treating CLIENTSTATUS as battle state: it belongs in the global user directory.
- Expecting LEFTBATTLE for departures: Teiserver often suppresses it; REMOVESCRIPTTAGS (`game/players/<name>/…`) and REMOVEUSER are the real leave signals.
- Case-sensitive name matching against script-tag names (always lowercased).

# Reference

## Protocol facts (hard-won — don't relearn these)

- **Plaintext.** The connection is plain TCP — no TLS. Connect plaintext, server
  sends `TASSERVER`, client sends `LOGIN`. In the Worker:
  `connect(..., {secureTransport:"off"})`. (Earlier revisions used the STLS
  upgrade dance; TLS was removed entirely since the server accepts plaintext.)
- **LOGIN format** Teiserver accepts (verified vs BYAR-Chobby + Teiserver
  `spring_in.ex` regex `^(\S+) (\S+) (0) ([0-9\.\*]+) ([^\t]+)?\t?([^\t]+)?\t?([^\t]+)?`):
  ```
  LOGIN <user> <base64(md5(pass))> 0 * <lobbyName>\t<lobby_hash>\t<flags>
  ```
  - field 3 (cpu) must be literal `0`; field 4 (ip) `*` is fine.
  - **lobby_hash** (field 6) must be **non-empty** — Teiserver rejects `0` with
    "LobbyHash/UserID missing in login". BYAR-Chobby sends a device fingerprint
    `"<macAddrHash> <sysInfoHash[:16]>"`. We mirror the shape with a stable
    per-account `"<hash> <hash>"`. It's untrusted (smurf grouping only).
  - **flags** (field 7) = `b sp` (b: JOINBATTLEREQUEST/…, sp: script passwords).
  - **lobbyName** (field 5) becomes the user's `lobby_client`, broadcast in
    `ADDUSER`. We send `lavabalance`. Teiserver maps known names to an
    `optimisation_level` (unknown → `:full`); it is self-declared, NOT used for auth.
- **Password:** Teiserver uses `try_md5_login`, so `base64(md5(password))` works.
  We store it **pre-hashed** (WebCrypto has no MD5).
- **Battle status bitfield** (`src/protocol/battleStatus.ts`, verified vs Chobby
  `EncodeBattleStatus`/`ParseBattleStatus`): bit1 ready, **bit10 mode (1=player,
  0=spectator)**, 11-17 handicap (Chobby ignores it), **22-23 sync** (0 unknown, 1
  synced, **2 unsynced**), 24-27 side. **team and ally are 8-bit**, each split across a
  low nibble in the lower 16 bits (team 2-5, ally 6-9) and a **high nibble in the upper
  16 bits** (team 18-21, ally 28-31) — a 16v16 game has team/ally numbers > 15, so both
  nibbles must be reassembled (ally's high nibble can reach bit 31, so encode `>>> 0`
  and decode with unsigned shifts). Join as spectator = `MYBATTLESTATUS` with the
  spectator bit clear. The decoded **sync** is surfaced per player (`Player.sync`,
  `/api/lobbies`): a member is `sync:2` (unsynced) while they lack the map/game content
  — typically still **downloading the map** after a host map change — shown in the UI as
  an hourglass (⏳) in place of the ready tick.
- **ADDUSER** = `ADDUSER <name> <country> <accountid> <lobby_client>`. country is
  server geo-IP; accountid is Teiserver's; lobby_client is the client's LOGIN name.
- **CLIENTSTATUS** = `CLIENTSTATUS <userName> <status>` — a **global** (server-wide,
  not battle-scoped; distinct from the per-battle CLIENTBATTLESTATUS) status push.
  Status bitfield (MYSTATUS layout, decoded in `src/protocol/clientStatus.ts`, verified
  vs BYAR-Chobby liblobby `Interface:_OnClientStatus`): **b0 = in game** (0 normal, 1 in
  the running match), b1 away, **b2-b4 rank**, b5 access/mod, b6 bot. `parseClientStatus`
  decodes all of these via `decodeClientStatus`. Because it's a per-**user** fact (not
  state of any one battle), it is **not routed to a battle**: the Dispatcher records it
  on the **global user directory** (`UserRepository`, `noteClientStatus`), keyed by
  lowercased name, alongside the skill (see SETSCRIPTTAGS). `/api/lobbies` augments each
  battle's roster from that directory by name. Three fields are consumed:
  - **in-game**: "the game started" / "is this player actually in the game" —
    **independent of lobby membership**: a member is `inGame:false` until the match
    launches and they load in. Per the protocol a *battle* is "in-game" when its
    **founder/host** is in-game (founder going 0→1). Surfaced per player in
    `/api/lobbies` (looked up from the user directory) and shown in the UI as a
    **crossed-swords emoji** (⚔️) in place of the ready tick.
  - **rank**: the account level. Chobby decodes it as `level = ((status>>2)%8)+1`, i.e.
    the 0-7 rank bits shifted up to a **1-8 display level** that maps 1:1 onto the rank
    icons (`public/ranks/1.png` .. `8.png`); `decodeClientStatus` follows that convention
    (`rank` = the 1-8 level). Surfaced as each player's `rank` in `/api/lobbies` + the UI
    (a rank icon left of the name).
  - **away**: stored on the user too; exposed in `/api/lobbies` (not yet shown in the UI).
- **BarManager `BattleStateChanged` carries the lobby's own settings**, pushed unsolicited by the host — no query needed. Observed payload: `{locked, autoBalance, teamSize, nbTeams, balanceMode, preset, mutes, boss}`. `Battle.applyBarManager` consumes **`boss`** (the boss roster), **`autoBalance`** (lowercased, exposed as `autoBalanceSetting` / in the snapshot) and **`balanceMode`** (lowercased, e.g. `clan;skill`, exposed as `balanceModeSetting` / snapshot `balanceMode`, published in the lobby API + `/health` and read by the bot's balancer — see "Balance mode" below); the rest is still ignored (`teamSize`/`nbTeams` would be the natural source for a per-lobby balance size instead of the bot's hard-coded 16). The bot drives its own auto-balance from it — armed only while the lobby's is `"off"` — so SPADS and the bot never shuffle the same lobby, and EVERY path that would send an `!fb` re-checks it through `autoBalanceBlocksForce()` (SPADS's `hForce` silently discards forced teams otherwise, and only PMs the bot about it). Only as fresh as the last broadcast, same caveat as the boss list.
- **SAIDBATTLEEX** = `SAIDBATTLEEX <userName> <message>` — an announce-style chat line
  in a battle. It carries no battle id, so (like CLIENTBATTLESTATUS and SETSCRIPTTAGS)
  it's routed to the battle the bot is currently joined to (`Battles.currentBattle`,
  set by the Dispatcher's `handleSelfMembership`).
  Usually plain text, but BAR also smuggles structured state as
  `* BarManager|<json>`. The JSON has a **single top-level key = the event type**
  (`BattleStateChanged`, `currentVote`, `onVoteStart`, `ringTime`, `onVoteStop`, …).
  Consumed: **BattleStateChanged** (its `boss` field is a comma-separated name
  list that drives each battle's tracked boss roster) and the **vote lifecycle**
  — `onVoteStart`/`currentVote` carry SPADS's currentVote object (its `command`
  token array + `user` become `Battle.voteInProgress` / snapshot `vote`), and
  `onVoteStop` clears it whatever the result. The bot's start-vote guard runs on
  that state (see `src/bot/bot.ts`).
- **SETSCRIPTTAGS** = `SETSCRIPTTAGS {pair1}[\t{pair2}…]` — relayed from the host;
  TAB-separated `key=value` pairs (the server lowercases all keys). Carries no battle
  id, so it routes to the bot's current battle. `parseSetScriptTags` splits it into two
  tag families, consumed in different places (each merged across messages):
  - `game/players/<name>/skill=[OS]` → per-player skill/OS (bracket-stripped to a
    number). Consumed by the **Dispatcher** in `noteSkill`, stored on the global user
    directory (`UserRepository`, keyed lowercase — the server already lowercases the tag
    keys, so they reconcile case-insensitively with the real-case roster/CLIENTSTATUS
    names). Surfaced as each player's `skill` in `/api/lobbies` + the UI table.
  - `game/modoptions/<name>=<value>` → a per-battle mod-option map
    (`Battle.applyScriptTags` → `Battle.modOptions()`), **recorded but intentionally not
    exposed via the API or UI**.

  All other tags (e.g. `skilluncertainty`, `game/startmetal`) are ignored.
- **s.battle.update_lobby_title** = `s.battle.update_lobby_title <battleId>\t<title>` — a
  Teiserver push (relayed alongside the legacy protocol) sent when the host renames the
  lobby. Unlike the untagged lines above, it carries an explicit battle id (a
  space-separated word), so it routes by id; the title is free text after the first TAB
  (may contain spaces and `|` separators, e.g. `Supreme LAVA | 8v8 | Unranked`).
  `parseUpdateLobbyTitle` extracts it; `Battle.applyTitle` updates the battle's `title`
  (initially set from BATTLEOPENED).
- **BATTLEOPENED / UPDATEBATTLEINFO map fields** (verified vs Chobby + live captures):
  - `BATTLEOPENED ... <mapHash> <engineName>\t<engineVersion>\t<map>\t<title>\t<gameName>`
    — `engineName` is space-delimited after `mapHash`, then the five trailing fields are
    **TAB-separated** (multiple Spring "sentences"). `parseBattleOpened` reads engineName
    from `words[10]` and the rest from `sentences[0..]`.
  - `UPDATEBATTLEINFO <id> <spectatorCount> <locked> <mapHash> <mapName>` — `mapName` is a
    **single** sentence: the **space-delimited remainder** after `mapHash` (it may contain
    spaces, e.g. `Hellas Basin v1.4`) with **no TAB**, matching Chobby's `([^\t]+)`. So
    `parseUpdateBattleInfo` rejoins `words.slice(4)` (NOT `sentences[0]`, which is empty on
    the wire — reading it there silently dropped every map name).
- **One user = one battle**, and Teiserver rejects duplicate logins for the same
  account. So running multiple rooms concurrently needs **one bot account per room**
  (pass `{username, passwordHash}` to `/start`; defaults to the configured account).
- **Departures often arrive with NO LEFTBATTLE.** Teiserver assigns unknown lobby
  clients an "optimisation level" that suppresses most membership broadcasts (a
  45-min bot capture had 29 CLIENTBATTLESTATUS names but only 2 LEFTBATTLE). The
  load-bearing leave signals are instead: **REMOVESCRIPTTAGS** (SPADS clears
  `game/players/<name>/…` when a player leaves — names lowercased, matched
  case-insensitively; routed to the current battle like SETSCRIPTTAGS) and
  **REMOVEUSER** (server-wide disconnect → purge the user from every battle
  roster). Without
  consuming both, rosters accumulate phantom players (the "18 players in an 8v8"
  bug).
