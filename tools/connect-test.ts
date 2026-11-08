// Standalone CLI to test connecting to a Teiserver / Spring lobby server and watch
// the raw protocol exchange. Runs in Node (NOT the Worker), so it can use node:net /
// node:crypto. Run it with: `pnpm run connect-test -- <flags>`.
//
// The lobby speaks the legacy Spring protocol in plaintext (no TLS): the server
// sends a TASSERVER greeting, then the client sends LOGIN.

import { connect as netConnect, type Socket } from "node:net";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

import { login, joinBattle, myBattleStatus, pong } from "../src/protocol/commands";
import { LineBuffer, parseMessage } from "../src/protocol/framing";
import { parseBattleOpened } from "../src/protocol/events";

// node:util parseArgs has no built-in --no-<flag> negation; handle opt-outs manually.
const rawArgs = process.argv.slice(2);
const doLogin = !rawArgs.includes("--no-login");
const asSpectator = !rawArgs.includes("--no-spectator");
const filteredArgs = rawArgs.filter((x) => x !== "--no-login" && x !== "--no-spectator");

const { values: a } = parseArgs({
  args: filteredArgs,
  options: {
    host: { type: "string", default: "server4.beyondallreason.info" },
    port: { type: "string", default: "8200" },
    user: { type: "string", default: "lavabalance" },
    pass: { type: "string" }, // plaintext; hashed locally (md5 -> base64)
    "pass-hash": { type: "string" }, // pre-hashed base64(md5(password))
    "lobby-name": { type: "string", default: "lavabalance-cli 0.1.0" },
    "compat-flags": { type: "string", default: "b sp" }, // matches BYAR-Chobby
    "lobby-hash": { type: "string" }, // device fingerprint; default derived from --user
    battle: { type: "string" }, // numeric id or title substring to join
    timeout: { type: "string", default: "20000" }, // ms before exit
    "show-secrets": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (a.help) {
  console.log(`Usage: pnpm run connect-test -- [flags]

  --host <h>           default server4.beyondallreason.info
  --port <n>           default 8200
  --user <name>        default lavabalance
  --pass <pw>          plaintext password (hashed locally)
  --pass-hash <hash>   pre-hashed base64(md5(password))
  --lobby-name <s>     default "lavabalance-cli 0.1.0"
  --compat-flags <s>   default "b sp" (matches BYAR-Chobby)
  --lobby-hash <s>     device fingerprint "<hash> <hash>" (default derived from --user)
  --battle <idOrTitle> join a battle after login (id or title substring)
  --no-login           connect and watch only, do not send LOGIN
  --no-spectator       join as player instead of spectator
  --timeout <ms>       default 20000
  --show-secrets       do not redact the LOGIN password hash in output
`);
  process.exit(0);
}

const host = a.host!;
const port = Number(a.port);
const timeoutMs = Number(a.timeout);

const passwordHash =
  a["pass-hash"] ??
  (a.pass ? createHash("md5").update(a.pass, "utf8").digest("base64") : "");

// The lobby_hash field is BYAR-Chobby's device fingerprint: "<macAddrHash>
// <sysInfoHash[:16]>" (two space-separated hashes; Teiserver uses it for smurf
// detection and rejects a bare "0"). Mirror that shape with stable per-account
// hashes unless overridden.
const md5hex = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
const lobbyHash = a["lobby-hash"] ?? `${md5hex(a.user!)} ${md5hex(a.user! + "|sys").slice(0, 16)}`;

const t0 = Date.now();
const stamp = () => `+${String(Date.now() - t0).padStart(5)}ms`;
const redact = (line: string) => {
  if (a["show-secrets"] || !line.startsWith("LOGIN ")) return line;
  const tok = line.split(" ");
  if (tok.length > 2) tok[2] = "***";
  return tok.join(" ");
};

let sock: Socket;
let buf = new LineBuffer();
let loginSent = false;
let joinSent = false;
let accepted = false;
const battles = new Map<number, string[]>(); // id -> sentences (for title match)

function send(line: string): void {
  console.log(`${stamp()} →  ${redact(line)}`);
  sock.write(line + "\n");
}

function resolveBattleId(): number | undefined {
  const t = (a.battle ?? "").trim();
  if (!t) return undefined;
  if (/^\d+$/.test(t)) {
    const id = Number(t);
    return battles.has(id) ? id : undefined;
  }
  const needle = t.toLowerCase();
  for (const [id, sentences] of battles) {
    if (sentences.some((s) => s.toLowerCase().includes(needle))) return id;
  }
  return undefined;
}

function tryJoin(): void {
  if (joinSent || !a.battle) return;
  const id = resolveBattleId();
  if (id === undefined) return;
  joinSent = true;
  send(joinBattle(id));
}

function sendLogin(): void {
  if (loginSent || !doLogin) return;
  loginSent = true;
  send(
    login({
      username: a.user!,
      passwordHash,
      lobbyName: a["lobby-name"]!,
      compatFlags: a["compat-flags"]!,
      userId: lobbyHash,
    }),
  );
}

function handleLine(line: string): void {
  console.log(`${stamp()} ←  ${line}`);
  const m = parseMessage(line);
  switch (m.cmd) {
    case "TASSERVER":
      // Plaintext greeting → log in.
      sendLogin();
      break;
    case "ACCEPTED":
      accepted = true;
      console.log(`${stamp()} ✔  login accepted`);
      tryJoin();
      break;
    case "DENIED":
      console.error(`${stamp()} ✘  login denied: ${[...m.words, ...m.sentences].join(" ")}`);
      break;
    case "LOGININFOEND":
      tryJoin();
      break;
    case "BATTLEOPENED": {
      const b = parseBattleOpened(m);
      if (b) {
        battles.set(b.battleId, b.sentences);
        tryJoin();
      }
      break;
    }
    case "JOINBATTLE":
      console.log(`${stamp()} ✔  joined battle ${m.words[0]}`);
      if (asSpectator) send(myBattleStatus());
      break;
    case "JOINBATTLEFAILED":
      console.error(`${stamp()} ✘  join failed: ${[...m.words, ...m.sentences].join(" ")}`);
      break;
    case "PING":
      send(pong());
      break;
  }
}

function attach(s: Socket): void {
  s.setEncoding("utf8");
  s.on("data", (chunk: string) => {
    for (const line of buf.push(chunk)) handleLine(line);
  });
  s.on("error", (err) => console.error(`${stamp()} ✘  socket error: ${err.message}`));
  s.on("close", (hadError) => {
    console.log(`${stamp()} ⛔ connection closed${hadError ? " (with error)" : ""}`);
    finish(accepted ? 0 : 1);
  });
}

function finish(code: number): void {
  clearTimeout(timer);
  try {
    sock.destroy();
  } catch {
    /* ignore */
  }
  process.exit(code);
}

console.log(`connecting to ${host}:${port} user=${a.user} login=${doLogin}`);

sock = netConnect({ host, port }, () => console.log(`${stamp()} 🔌 TCP connected`));
attach(sock);

const timer = setTimeout(() => {
  console.log(`${stamp()} ⏱  timeout (${timeoutMs}ms) reached, closing`);
  finish(accepted ? 0 : 1);
}, timeoutMs);
