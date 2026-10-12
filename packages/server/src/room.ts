import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  addToStats, applyAction, createGame, newGameStats, recordTurn, getPlayer, legalActions, newBotMemory, strategyBotAction,
  type Action, type BotMemory, type Envelope, type GameEvent, type GameSetup, type GameState, type GameStats,
} from '@monopoly/engine';

export const MAX_SEATS = 8;
export const AUCTION_OPEN_MS = Number(process.env.AUCTION_OPEN_MS ?? 15_000); // time for the first bid
export const AUCTION_RAISE_MS = Number(process.env.AUCTION_RAISE_MS ?? 5_000); // sale closes this long after the last raise
export const BOT_DELAY_MS = Number(process.env.BOT_DELAY_MS ?? 900); // pause before each computer move, so people can follow

const BOT_NAMES = ['Ada', 'Turing', 'Hopper', 'Babbage', 'Lovelace', 'Knuth', 'Shannon', 'Dijkstra'];
const TOKENS = ['🎩', '🚗', '🐕', '🚢', '👢', '🐈', '🦖', '🦆'];
const COLORS = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00acc1', '#6d4c41', '#d81b60'];

export interface Seat { playerId: string; name: string; token: string; color: string; seatToken: string; bot?: boolean; advanced?: boolean; watching?: boolean }
export interface LobbyOptions { startingCash: number; freeParkingJackpot: boolean; shuffleOrder: boolean }

export interface Client {
  send(msg: unknown): void;
  playerId: string | null;
}

interface SavedGame {
  id: string;
  seed: number;
  setup: GameSetup;
  seats: Seat[];
  adminId: string | null;
  options: LobbyOptions;
  actions: Envelope[];
  finished: boolean;
}

/** Roughly how long clients spend animating these events at normal speed (see client/src/animator.ts). */
function animationMs(events: GameEvent[]): number {
  if (!BOT_DELAY_MS) return 0; // tests run bots flat out
  let ms = 0;
  for (const e of events) {
    if (e.type === 'diceRolled') ms += 1350;
    else if (e.type === 'cardDrawn') ms += 1600;
    else if (e.type === 'moved') {
      const steps = (e.to - e.from + 40) % 40;
      ms += 350 + (steps > 12 ? Math.min(steps, 40 - steps) * 110 : steps * 230);
    }
  }
  return ms;
}

/** The single game room a host runs: lobby, seats, the authoritative engine state, timers and the action log. */
export class Room {
  seats: Seat[] = [];
  adminId: string | null = null;
  options: LobbyOptions = { startingCash: 1500, freeParkingJackpot: false, shuffleOrder: true };
  clients = new Set<Client>();
  game: { id: string; seed: number; setup: GameSetup; actions: Envelope[]; state: GameState; stats: GameStats } | null = null;
  private nextPlayer = 1;
  private auctionKey: string | null = null;
  private auctionTimer: NodeJS.Timeout | null = null;
  auctionClosesAt: number | null = null;
  private botTimer: NodeJS.Timeout | null = null;
  private botMemory = new Map<string, BotMemory>();

  constructor(private gamesDir: string | null, private now: () => number = Date.now) {}

  // ------------------------------------------------------------ connections

  connect(client: Client) {
    this.clients.add(client);
  }

  disconnect(client: Client) {
    this.clients.delete(client);
    if (client.playerId) this.broadcastPresence();
  }

  handle(client: Client, raw: unknown) {
    const msg = raw as { type?: string; [k: string]: unknown };
    if (!msg || typeof msg.type !== 'string') return client.send({ type: 'error', message: 'Bad message' });
    switch (msg.type) {
      case 'hello': return this.hello(client, msg.seatToken);
      case 'claimSeat': return this.claimSeat(client, msg);
      case 'leaveSeat': return this.leaveSeat(client);
      case 'setWatching': return this.setWatching(client, msg.watching);
      case 'addBot': return this.addBot(client);
      case 'removeBot': return this.removeBot(client, msg.playerId);
      case 'setBotLevel': return this.setBotLevel(client, msg.playerId, msg.advanced);
      case 'setOptions': return this.setOptions(client, msg.options);
      case 'startGame': return this.startGame(client);
      case 'endGame': return this.endGame(client);
      case 'removePlayer': return this.removePlayer(client, msg.playerId);
      case 'action': return this.action(client, msg.action as Action, msg.clientSeq);
      default: return client.send({ type: 'error', message: `Unknown message ${msg.type}` });
    }
  }

  private hello(client: Client, seatToken: unknown) {
    const seat = typeof seatToken === 'string' ? this.seats.find((s) => s.seatToken === seatToken) : undefined;
    client.playerId = seat?.playerId ?? null;
    client.send({ type: 'welcome', playerId: client.playerId, seatToken: seat?.seatToken ?? null });
    client.send(this.lobbyMessage());
    if (this.game) client.send(this.stateMessage([]));
    if (seat) this.broadcastPresence();
  }

  private claimSeat(client: Client, msg: Record<string, unknown>) {
    if (this.game) return client.send({ type: 'error', message: 'The game has already started' });
    if (client.playerId) return client.send({ type: 'error', message: 'You already have a seat' });
    if (this.playingSeats() >= MAX_SEATS) return client.send({ type: 'error', message: 'The table is full' });
    const name = String(msg.name ?? '').trim().slice(0, 20);
    const token = String(msg.token ?? '').slice(0, 8);
    const color = String(msg.color ?? '');
    if (!name) return client.send({ type: 'error', message: 'Pick a name' });
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return client.send({ type: 'error', message: 'Pick a colour' });
    if (!token) return client.send({ type: 'error', message: 'Pick a token' });
    if (this.seats.some((s) => s.token === token)) return client.send({ type: 'error', message: 'That token is taken' });
    if (this.seats.some((s) => s.color.toLowerCase() === color.toLowerCase()))
      return client.send({ type: 'error', message: 'That colour is taken' });
    if (this.seats.some((s) => s.name.toLowerCase() === name.toLowerCase()))
      return client.send({ type: 'error', message: 'That name is taken' });
    const seat: Seat = { playerId: `p${this.nextPlayer++}`, name, token, color, seatToken: randomUUID() };
    this.seats.push(seat);
    this.adminId ??= seat.playerId;
    client.playerId = seat.playerId;
    client.send({ type: 'welcome', playerId: seat.playerId, seatToken: seat.seatToken });
    this.broadcastLobby();
  }

  private leaveSeat(client: Client) {
    if (this.game) return client.send({ type: 'error', message: 'You cannot leave during a game' });
    const id = client.playerId;
    if (!id) return;
    this.seats = this.seats.filter((s) => s.playerId !== id);
    for (const c of this.clients) if (c.playerId === id) {
      c.playerId = null;
      c.send({ type: 'welcome', playerId: null, seatToken: null });
    }
    if (this.adminId === id) this.adminId = this.seats.find((s) => !s.bot)?.playerId ?? null;
    if (!this.adminId) this.seats = []; // computer players leave with the last person
    this.broadcastLobby();
  }

  /** A person can keep their seat (and admin powers) but sit the game out, e.g. to watch computer players. */
  private setWatching(client: Client, watching: unknown) {
    if (this.game) return client.send({ type: 'error', message: 'The game has already started' });
    const seat = this.seats.find((s) => s.playerId === client.playerId && !s.bot);
    if (!seat) return client.send({ type: 'error', message: 'Take a seat first' });
    if (seat.watching && watching !== true && this.playingSeats() >= MAX_SEATS) return client.send({ type: 'error', message: 'The table is full' });
    seat.watching = watching === true;
    // Back in the game: if a computer player took this person's token or colour meanwhile, give them a free one.
    if (!seat.watching) {
      const clash = (f: (s: Seat) => string) => this.seats.some((s) => s !== seat && !s.watching && f(s).toLowerCase() === f(seat).toLowerCase());
      if (clash((s) => s.token)) seat.token = this.freeChoice(TOKENS, (s) => s.token, seat);
      if (clash((s) => s.color)) seat.color = this.freeChoice(COLORS, (s) => s.color, seat);
    }
    this.broadcastLobby();
  }

  /** The first option no playing seat uses. There are 8 of each and at most 8 players, so one is always free. */
  private freeChoice(list: string[], used: (s: Seat) => string, except?: Seat): string {
    const taken = (x: string) => this.seats.some((s) => s !== except && !s.watching && used(s).toLowerCase() === x.toLowerCase());
    return list.find((x) => !taken(x))!;
  }

  /** Seats that will play; someone who is only watching does not take a player's place. */
  private playingSeats() {
    return this.seats.filter((s) => !s.watching).length;
  }

  private addBot(client: Client) {
    if (this.game) return client.send({ type: 'error', message: 'The game has already started' });
    if (!client.playerId || client.playerId !== this.adminId) return client.send({ type: 'error', message: 'Only the room admin can add computer players' });
    if (this.playingSeats() >= MAX_SEATS) return client.send({ type: 'error', message: 'The table is full' });
    // Someone only watching never appears on the board, so a computer player may reuse their token and colour.
    const name = this.freeChoice(BOT_NAMES.map((n) => `${n} (bot)`), (s) => s.name);
    const token = this.freeChoice(TOKENS, (s) => s.token);
    const color = this.freeChoice(COLORS, (s) => s.color);
    this.seats.push({ playerId: `p${this.nextPlayer++}`, name, token, color, seatToken: randomUUID(), bot: true, advanced: true });
    this.broadcastLobby();
  }

  private removeBot(client: Client, playerId: unknown) {
    if (this.game) return client.send({ type: 'error', message: 'The game has already started' });
    if (!client.playerId || client.playerId !== this.adminId) return client.send({ type: 'error', message: 'Only the room admin can remove computer players' });
    this.seats = this.seats.filter((s) => !(s.bot && s.playerId === playerId));
    this.broadcastLobby();
  }

  /** Advanced bots play every strategy; basic ones skip the newer tricks (see strategy.ts). */
  private setBotLevel(client: Client, playerId: unknown, advanced: unknown) {
    if (this.game) return client.send({ type: 'error', message: 'The game has already started' });
    if (!client.playerId || client.playerId !== this.adminId) return client.send({ type: 'error', message: 'Only the room admin can change computer players' });
    const seat = this.seats.find((s) => s.bot && s.playerId === playerId);
    if (!seat || typeof advanced !== 'boolean') return;
    seat.advanced = advanced;
    this.broadcastLobby();
  }

  private setOptions(client: Client, raw: unknown) {
    if (this.game) return client.send({ type: 'error', message: 'The game has already started' });
    if (!client.playerId || client.playerId !== this.adminId) return client.send({ type: 'error', message: 'Only the room admin can change options' });
    const o = (raw ?? {}) as Partial<LobbyOptions>;
    const cash = Number(o.startingCash);
    if (Number.isInteger(cash) && cash >= 100 && cash <= 10_000) this.options.startingCash = cash;
    if (typeof o.freeParkingJackpot === 'boolean') this.options.freeParkingJackpot = o.freeParkingJackpot;
    if (typeof o.shuffleOrder === 'boolean') this.options.shuffleOrder = o.shuffleOrder;
    this.broadcastLobby();
  }

  private startGame(client: Client) {
    if (this.game) return client.send({ type: 'error', message: 'The game has already started' });
    if (client.playerId !== this.adminId) return client.send({ type: 'error', message: 'Only the room admin can start' });
    const playing = this.seats.filter((s) => !s.watching);
    if (playing.length < 2) return client.send({ type: 'error', message: 'Need at least 2 players' });
    const seed = Math.floor(Math.random() * 2 ** 32);
    let order = playing.map(({ playerId, name, token, color }) => ({ id: playerId, name, token, color }));
    if (this.options.shuffleOrder) {
      order = order.map((p) => ({ p, k: Math.random() })).sort((a, b) => a.k - b.k).map((x) => x.p);
    }
    const setup: GameSetup = {
      players: order,
      rules: { startingCash: this.options.startingCash, freeParkingJackpot: this.options.freeParkingJackpot },
    };
    const id = new Date().toISOString().replace(/[:.]/g, '-');
    const state = createGame(setup, seed);
    this.game = { id, seed, setup, actions: [], state, stats: recordTurn(newGameStats(), state) };
    this.save();
    this.broadcastLobby();
    this.broadcastState([]);
    this.scheduleBots();
  }

  private endGame(client: Client) {
    if (!this.game) return;
    if (client.playerId !== this.adminId) return client.send({ type: 'error', message: 'Only the room admin can end the game' });
    this.save(true);
    this.game = null;
    this.clearAuctionTimer();
    this.clearBotTimer();
    this.broadcastLobby();
  }

  private removePlayer(client: Client, playerId: unknown) {
    if (!this.game) return client.send({ type: 'error', message: 'No game is running' });
    if (client.playerId !== this.adminId) return client.send({ type: 'error', message: 'Only the room admin can remove players' });
    if (typeof playerId !== 'string' || playerId === client.playerId)
      return client.send({ type: 'error', message: 'Use "Leave game" to leave yourself' });
    const error = this.dispatch({ action: { type: 'REMOVE_PLAYER', playerId }, by: 'host', seq: this.game.actions.length + 1 });
    if (error) client.send({ type: 'error', message: error });
  }

  private action(client: Client, action: Action, clientSeq: unknown) {
    if (!this.game) return client.send({ type: 'rejected', clientSeq, reason: 'No game is running' });
    if (!client.playerId) return client.send({ type: 'rejected', clientSeq, reason: 'You are watching, not playing' });
    // The sender is the socket's seat, never anything in the message.
    const error = this.dispatch({ action, by: client.playerId, seq: this.game.actions.length + 1 });
    if (error) client.send({ type: 'rejected', clientSeq, reason: error });
  }

  /** Runs one envelope through the engine; returns an error message or null. */
  dispatch(env: Envelope): string | null {
    if (!this.game) return 'No game is running';
    const result = applyAction(this.game.state, env);
    if ('error' in result) return result.error;
    this.game.state = result.state;
    this.game.actions.push(env);
    recordTurn(addToStats(this.game.stats, result.events), result.state);
    this.save();
    this.syncAuctionTimer();
    this.broadcastState(result.events);
    this.scheduleBots(animationMs(result.events));
    return null;
  }

  // ------------------------------------------------------------ computer players

  /** extraMs leaves time for the dice and token animation of the last move to play on screens. */
  private scheduleBots(extraMs = 0) {
    if (this.botTimer || !this.game || this.game.state.winner || !this.seats.some((s) => s.bot)) return;
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      this.runBots();
    }, BOT_DELAY_MS + extraMs);
  }

  /** Lets the first computer player with something to do make one move; the dispatch schedules the next. */
  private runBots() {
    if (!this.game) return;
    const s = this.game.state;
    for (const seat of this.seats) {
      if (!seat.bot || getPlayer(s, seat.playerId)?.bankrupt !== false) continue;
      if (!this.botMemory.has(seat.playerId)) this.botMemory.set(seat.playerId, newBotMemory({ advanced: seat.advanced !== false }));
      const action = strategyBotAction(s, seat.playerId, this.botMemory.get(seat.playerId));
      if (!action) continue;
      const seq = () => this.game!.actions.length + 1;
      const error = this.dispatch({ action, by: seat.playerId, seq: seq() });
      if (!error) return;
      // Should not happen; keep the game moving with the simplest legal step instead of stalling.
      console.warn(`${seat.name}: ${action.type} was rejected (${error})`);
      const order: Action['type'][] = ['PAY_DEBT', 'PASS_BID', 'DECLINE_BUY', 'REJECT_TRADE', 'ROLL_DICE', 'END_TURN', 'DECLARE_BANKRUPTCY'];
      const legal = legalActions(s, seat.playerId);
      const fallback = order.map((t) => legal.find((a) => a.type === t)).find(Boolean);
      if (fallback && !this.dispatch({ action: fallback, by: seat.playerId, seq: seq() })) return;
    }
  }

  private clearBotTimer() {
    if (this.botTimer) clearTimeout(this.botTimer);
    this.botTimer = null;
  }

  // ------------------------------------------------------------ auction clock

  private syncAuctionTimer() {
    const p = this.game?.state.pending;
    if (p?.type !== 'auction') return this.clearAuctionTimer();
    const key = `${p.id}:${p.highBid}`;
    if (key === this.auctionKey) return;
    this.clearAuctionTimer();
    this.auctionKey = key;
    const ms = p.highBidder ? AUCTION_RAISE_MS : AUCTION_OPEN_MS;
    this.auctionClosesAt = this.now() + ms;
    this.auctionTimer = setTimeout(() => {
      const cur = this.game?.state.pending;
      if (cur?.type === 'auction' && `${cur.id}:${cur.highBid}` === key) {
        this.dispatch({ action: { type: 'CLOSE_AUCTION' }, by: 'host', seq: this.game!.actions.length + 1 });
      }
    }, ms);
  }

  private clearAuctionTimer() {
    if (this.auctionTimer) clearTimeout(this.auctionTimer);
    this.auctionTimer = null;
    this.auctionKey = null;
    this.auctionClosesAt = null;
  }

  shutdown() {
    this.clearAuctionTimer();
    this.clearBotTimer();
  }

  // ------------------------------------------------------------ broadcasting

  private presence(): Record<string, boolean> {
    const online: Record<string, boolean> = {};
    for (const s of this.seats) online[s.playerId] = false;
    for (const c of this.clients) if (c.playerId) online[c.playerId] = true;
    for (const s of this.seats) if (s.bot) online[s.playerId] = true;
    return online;
  }

  lobbyMessage() {
    return {
      type: 'lobby',
      seats: this.seats.map(({ seatToken: _hidden, ...s }) => s),
      adminId: this.adminId,
      options: this.options,
      started: !!this.game,
      presence: this.presence(),
    };
  }

  stateMessage(events: GameEvent[]) {
    return {
      type: 'state',
      seq: this.game!.actions.length,
      state: this.game!.state,
      events,
      stats: this.game!.stats,
      auctionClosesAt: this.auctionClosesAt,
      serverNow: this.now(),
    };
  }

  private broadcast(msg: unknown) {
    for (const c of this.clients) c.send(msg);
  }

  private broadcastLobby() {
    this.broadcast(this.lobbyMessage());
  }

  private broadcastState(events: GameEvent[]) {
    if (this.game) this.broadcast(this.stateMessage(events));
  }

  private broadcastPresence() {
    this.broadcast({ type: 'presence', presence: this.presence() });
  }

  // ------------------------------------------------------------ saves

  private save(finished = false) {
    if (!this.gamesDir || !this.game) return;
    const data: SavedGame = {
      id: this.game.id,
      seed: this.game.seed,
      setup: this.game.setup,
      seats: this.seats,
      adminId: this.adminId,
      options: this.options,
      actions: this.game.actions,
      finished: finished || !!this.game.state.winner,
    };
    fs.mkdirSync(this.gamesDir, { recursive: true });
    const file = path.join(this.gamesDir, `${this.game.id}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
    fs.renameSync(`${file}.tmp`, file);
  }

  /** Reloads the newest unfinished game by replaying its action log. Returns true when a game was resumed. */
  resumeLatest(): boolean {
    if (!this.gamesDir || !fs.existsSync(this.gamesDir)) return false;
    const files = fs.readdirSync(this.gamesDir).filter((f) => f.endsWith('.json')).sort().reverse();
    for (const f of files) {
      let saved: SavedGame;
      try {
        saved = JSON.parse(fs.readFileSync(path.join(this.gamesDir, f), 'utf8'));
      } catch {
        continue;
      }
      if (saved.finished) continue;
      let state = createGame(saved.setup, saved.seed);
      const stats = recordTurn(newGameStats(), state);
      let ok = true;
      for (const env of saved.actions) {
        const r = applyAction(state, env);
        if ('error' in r) { ok = false; break; }
        state = r.state;
        recordTurn(addToStats(stats, r.events), state);
      }
      if (!ok) continue;
      this.seats = saved.seats;
      this.adminId = saved.adminId;
      this.options = saved.options;
      this.nextPlayer = 1 + Math.max(0, ...saved.seats.map((s) => Number(s.playerId.slice(1)) || 0));
      this.game = { id: saved.id, seed: saved.seed, setup: saved.setup, actions: saved.actions, state, stats };
      this.syncAuctionTimer();
      this.scheduleBots();
      return true;
    }
    return false;
  }
}
