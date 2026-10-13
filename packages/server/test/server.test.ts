// End-to-end check: scripted clients play through a real host over WebSockets,
// the host is killed mid-game, restarted, and the game resumes from its action log.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { randomBotAction, waitingOn, type GameState } from '@monopoly/engine';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3999;
const gamesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monopoly-games-'));

function startServer(args: string[] = []): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(here, '../src/index.ts'), ...args], {
    env: { ...process.env, PORT: String(PORT), GAMES_DIR: gamesDir, AUCTION_OPEN_MS: '300', AUCTION_RAISE_MS: '150' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    child.stdout!.on('data', (d) => { if (String(d).includes('host is running')) resolve(child); });
    child.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
}

let server: ChildProcess | null = null;
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) { console.error('FAIL:', msg); server?.kill('SIGKILL'); process.exit(1); }
}

let paused = false;
let rngState = 12345;
const rng = () => ((rngState = (rngState * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

class Bot {
  ws!: WebSocket;
  me: string | null = null;
  seatToken: string | null = null;
  state: GameState | null = null;
  seq = 0;
  lobby: any = null;
  errors: string[] = [];
  constructor(public name: string, public token: string, public color: string) {}

  connect(): Promise<void> {
    return new Promise((resolve) => {
      this.ws = new WebSocket(`ws://localhost:${PORT}/ws`);
      this.ws.on('open', () => { this.send({ type: 'hello', seatToken: this.seatToken }); resolve(); });
      this.ws.on('error', () => {});
      this.ws.on('message', (d) => this.onMessage(JSON.parse(String(d))));
    });
  }
  send(m: unknown) { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }
  onMessage(m: any) {
    if (m.type === 'welcome') { this.me = m.playerId; if (m.seatToken) this.seatToken = m.seatToken; }
    if (m.type === 'lobby') this.lobby = m;
    if (m.type === 'state') { this.state = m.state; this.seq = m.seq; this.maybeAct(); }
    if (m.type === 'rejected') { this.errors.push(m.reason); setTimeout(() => this.maybeAct(), 20); }
    if (m.type === 'error') this.errors.push(m.message);
  }
  maybeAct() {
    const s = this.state;
    if (paused || !s || !this.me || s.winner || !waitingOn(s).includes(this.me)) return;
    // Trades are covered by the engine tests; here bots just play the turn flow.
    for (let i = 0; i < 20; i++) {
      const a = randomBotAction(s, this.me, rng);
      // The random player sometimes picks nothing (say, a player in debt who declines bankruptcy): draw again.
      if (!a || a.type === 'PROPOSE_TRADE') continue;
      this.send({ type: 'action', action: a, clientSeq: 1 });
      return;
    }
    // Nothing usable came up this time; try again rather than stalling the game.
    setTimeout(() => this.maybeAct(), 20);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) assert(false, `timed out waiting for ${what}`); await wait(20); }
}

server = await startServer(['--new']);
const bots = [new Bot('Ana', '🎩', '#e53935'), new Bot('Budi', '🚗', '#1e88e5'), new Bot('Citra', '🐕', '#43a047')];
for (const b of bots) await b.connect();
for (const b of bots) { b.send({ type: 'claimSeat', name: b.name, token: b.token, color: b.color }); await until(() => !!b.me, 2000, 'seat'); }
assert(bots[0].lobby.adminId === bots[0].me, 'first seat is admin');

// A spectator cannot act, and a non-admin cannot start.
bots[1].send({ type: 'startGame' });
await wait(100);
assert(bots[1].errors.includes('Only the room admin can start'), 'non-admin start refused');

// Hold the bots still until the out-of-turn check below is done, so the turn cannot move under it.
paused = true;
bots[0].send({ type: 'setOptions', options: { freeParkingJackpot: true, startingCash: 500, unlimitedHouses: true } });
bots[0].send({ type: 'startGame' });
await until(() => bots.every((b) => b.state), 2000, 'game start');
assert(bots[0].state!.rules.freeParkingJackpot && bots[0].state!.rules.startingCash === 500, 'options applied'); assert(bots[0].state!.bank.houses === 999 && bots[0].state!.rules.hotelSupply === 999, 'unlimited houses');
console.log('Game started; turn order', bots[0].state!.turnOrder.join(', '));

// Impersonation is impossible: the server uses the socket's seat, not the message.
const notTurn = bots.find((b) => b.me !== bots[0].state!.turn.playerId)!;
notTurn.send({ type: 'action', action: { type: 'ROLL_DICE' }, clientSeq: 99, by: bots[0].state!.turn.playerId });
await wait(100);
assert(notTurn.errors.includes('It is not your turn'), 'acting out of turn is refused');

paused = false;
for (const b of bots) b.maybeAct();
await until(() => bots[0].seq >= 150, 60_000, '150 actions');

// Kill the host mid-game and restart it.
paused = true;
server!.kill('SIGKILL');
await wait(300);
// Messages may have been in flight, so the save file (not a client) is the truth about where the host stopped.
const saveFile = fs.readdirSync(gamesDir).filter((f) => f.endsWith('.json'))[0];
const seqBefore = JSON.parse(fs.readFileSync(path.join(gamesDir, saveFile), 'utf8')).actions.length;
for (const b of bots) b.state = null;
server = await startServer();
for (const b of bots) await b.connect();
await until(() => bots.every((b) => b.state), 3000, 'resume');
console.log(`Resumed at action ${bots[0].seq} (was ${seqBefore})`);
assert(bots[0].seq === seqBefore, 'resumed at the same action');
assert(bots.every((b) => b.me), 'everyone reclaimed their seat with the stored token');
paused = false;

for (const b of bots) b.maybeAct();
await until(() => !!bots[0].state?.winner || bots[0].seq >= 4000, 240_000, 'game end');
const s = bots[0].state!;
console.log(s.winner ? `Winner: ${s.players.find((p) => p.id === s.winner)!.name} after ${bots[0].seq} actions, ${s.turn.number} turns` : `Stopped at ${bots[0].seq} actions without a winner`);
server.kill('SIGKILL');
for (const b of bots) b.ws.close();
fs.rmSync(gamesDir, { recursive: true, force: true });
console.log('PASS');
process.exit(0);
