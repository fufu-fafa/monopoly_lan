import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { applyAction, createGame, type Action, type Envelope, type GameEvent, type GameSetup, type GameState } from '@monopoly/engine';

export const MAX_SEATS = 8;
export const AUCTION_OPEN_MS = Number(process.env.AUCTION_OPEN_MS ?? 15_000); // time for the first bid
export const AUCTION_RAISE_MS = Number(process.env.AUCTION_RAISE_MS ?? 5_000); // sale closes this long after the last raise

export interface Seat { playerId: string; name: string; token: string; color: string; seatToken: string }
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

/** The single game room a host runs: lobby, seats, the authoritative engine state, timers and the action log. */
export class Room {
  seats: Seat[] = [];
  adminId: string | null = null;
  options: LobbyOptions = { startingCash: 1500, freeParkingJackpot: false, shuffleOrder: true };
  clients = new Set<Client>();
  game: { id: string; seed: number; setup: GameSetup; actions: Envelope[]; state: GameState } | null = null;
  private nextPlayer = 1;
  private auctionKey: string | null = null;
  private auctionTimer: NodeJS.Timeout | null = null;
  auctionClosesAt: number | null = null;

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
    if (this.seats.length >= MAX_SEATS) return client.send({ type: 'error', message: 'The table is full' });
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
    if (this.adminId === id) this.adminId = this.seats[0]?.playerId ?? null;
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
    if (this.seats.length < 2) return client.send({ type: 'error', message: 'Need at least 2 players' });
    const seed = Math.floor(Math.random() * 2 ** 32);
    let order = this.seats.map(({ playerId, name, token, color }) => ({ id: playerId, name, token, color }));
    if (this.options.shuffleOrder) {
      order = order.map((p) => ({ p, k: Math.random() })).sort((a, b) => a.k - b.k).map((x) => x.p);
    }
    const setup: GameSetup = {
      players: order,
      rules: { startingCash: this.options.startingCash, freeParkingJackpot: this.options.freeParkingJackpot },
    };
    const id = new Date().toISOString().replace(/[:.]/g, '-');
    this.game = { id, seed, setup, actions: [], state: createGame(setup, seed) };
    this.save();
    this.broadcastLobby();
    this.broadcastState([]);
  }

  private endGame(client: Client) {
    if (!this.game) return;
    if (client.playerId !== this.adminId) return client.send({ type: 'error', message: 'Only the room admin can end the game' });
    this.save(true);
    this.game = null;
    this.clearAuctionTimer();
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
    this.save();
    this.syncAuctionTimer();
    this.broadcastState(result.events);
    return null;
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
  }

  // ------------------------------------------------------------ broadcasting

  private presence(): Record<string, boolean> {
    const online: Record<string, boolean> = {};
    for (const s of this.seats) online[s.playerId] = false;
    for (const c of this.clients) if (c.playerId) online[c.playerId] = true;
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
      let ok = true;
      for (const env of saved.actions) {
        const r = applyAction(state, env);
        if ('error' in r) { ok = false; break; }
        state = r.state;
      }
      if (!ok) continue;
      this.seats = saved.seats;
      this.adminId = saved.adminId;
      this.options = saved.options;
      this.nextPlayer = 1 + Math.max(0, ...saved.seats.map((s) => Number(s.playerId.slice(1)) || 0));
      this.game = { id: saved.id, seed: saved.seed, setup: saved.setup, actions: saved.actions, state };
      this.syncAuctionTimer();
      return true;
    }
    return false;
  }
}
