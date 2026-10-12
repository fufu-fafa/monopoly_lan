// Computer players: the admin seats bots in the lobby, then one scripted person plays a full game against them.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { randomBotAction, waitingOn, type GameState } from '@monopoly/engine';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3998;
const gamesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monopoly-bots-'));

const server: ChildProcess = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(here, '../src/index.ts'), '--new'], {
    env: { ...process.env, PORT: String(PORT), GAMES_DIR: gamesDir, AUCTION_OPEN_MS: '300', AUCTION_RAISE_MS: '150', BOT_DELAY_MS: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.stdout!.on('data', (d) => { if (String(d).includes('host is running')) resolve(child); });
  child.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
});

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) { console.error('FAIL:', msg); server.kill('SIGKILL'); process.exit(1); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) assert(false, `timed out waiting for ${what}`); await wait(20); }
}

let rngState = 777;
const rng = () => ((rngState = (rngState * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

class Person {
  ws!: WebSocket;
  me: string | null = null;
  state: GameState | null = null;
  seq = 0;
  lobby: any = null;
  errors: string[] = [];
  connect(): Promise<void> {
    return new Promise((resolve) => {
      this.ws = new WebSocket(`ws://localhost:${PORT}/ws`);
      this.ws.on('open', () => { this.send({ type: 'hello', seatToken: null }); resolve(); });
      this.ws.on('message', (d) => this.onMessage(JSON.parse(String(d))));
    });
  }
  send(m: unknown) { this.ws.send(JSON.stringify(m)); }
  onMessage(m: any) {
    if (m.type === 'welcome') this.me = m.playerId;
    if (m.type === 'lobby') this.lobby = m;
    if (m.type === 'state') { this.state = m.state; this.seq = m.seq; this.maybeAct(); }
    if (m.type === 'rejected') setTimeout(() => this.maybeAct(), 20);
    if (m.type === 'error') this.errors.push(m.message);
  }
  maybeAct() {
    const s = this.state;
    if (!s || !this.me || s.winner || !waitingOn(s).includes(this.me)) return;
    for (let i = 0; i < 20; i++) {
      const a = randomBotAction(s, this.me, rng);
      if (a?.type === 'PROPOSE_TRADE') continue;
      if (a) this.send({ type: 'action', action: a, clientSeq: 1 });
      return;
    }
  }
}

const kp = new Person();
const guest = new Person();
await kp.connect();
await guest.connect();
kp.send({ type: 'claimSeat', name: 'Kp', token: '🎩', color: '#e53935' });
await until(() => !!kp.me, 2000, 'seat');

guest.send({ type: 'addBot' });
await wait(100);
assert(guest.errors.includes('Only the room admin can add computer players'), 'only the admin adds bots');

for (let i = 0; i < 4; i++) kp.send({ type: 'addBot' });
await until(() => kp.lobby?.seats.length === 5, 2000, 'bots seated');
const botSeats = kp.lobby.seats.filter((s: any) => s.bot);
assert(botSeats.length === 4 && new Set(kp.lobby.seats.map((s: any) => s.token)).size === 5, 'bots get their own tokens');
assert(botSeats.every((s: any) => kp.lobby.presence[s.playerId]), 'bots show as online');
kp.send({ type: 'removeBot', playerId: botSeats[3].playerId });
await until(() => kp.lobby.seats.length === 4, 2000, 'bot removed');

kp.send({ type: 'startGame' });
await until(() => !!kp.state, 2000, 'game start');
await until(() => !!kp.state?.winner, 240_000, 'game end');
const s = kp.state!;
const winner = s.players.find((p) => p.id === s.winner)!;
console.log(`Winner: ${winner.name} after ${kp.seq} actions, ${s.turn.number} turns`);
assert(s.log.length > 0, 'game ran');
server.kill('SIGKILL');
kp.ws.close();
guest.ws.close();
fs.rmSync(gamesDir, { recursive: true, force: true });
console.log('PASS');
process.exit(0);
