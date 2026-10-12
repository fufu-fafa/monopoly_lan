import { applyAction, createGame, randomBotAction, waitingOn, activePlayers, BOARD, CARDS, groupSpaces } from '../src';
import type { Action, GameState, PlayerId, Ruleset } from '../src';

export function newGame(n = 2, seed = 1, rules: Partial<Ruleset> = {}): GameState {
  const players = Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}`, token: '🎩', color: '#000' }));
  return createGame({ players, rules }, seed);
}

let seq = 0;
export function act(s: GameState, by: PlayerId | 'host', action: Action): GameState {
  const r = applyAction(s, { action, by, seq: ++seq });
  if ('error' in r) throw new Error(`${by} ${action.type}: ${r.error}`);
  return r.state;
}

export function tryAct(s: GameState, by: PlayerId | 'host', action: Action) {
  return applyAction(s, { action, by, seq: ++seq });
}

export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    let t = (a = (a + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function checkInvariants(s: GameState) {
  let houses = 0, hotels = 0;
  for (const [k, prop] of Object.entries(s.properties)) {
    const sp = BOARD[Number(k)];
    if (prop.buildings === 5) hotels++; else houses += prop.buildings;
    if (prop.buildings && sp.kind !== 'street') throw new Error('buildings on non-street');
    if (prop.mortgaged && prop.buildings) throw new Error('mortgaged with buildings');
    if (prop.buildings && !prop.ownerId) throw new Error('unowned with buildings');
    if (prop.ownerId && s.players.find((p) => p.id === prop.ownerId)!.bankrupt) throw new Error('bankrupt owner');
    if (sp.kind === 'street' && s.rules.evenBuild && prop.buildings) {
      const b = groupSpaces(sp.group).map((i) => s.properties[i].buildings);
      if (Math.max(...b) - Math.min(...b) > 1) throw new Error('uneven build');
    }
  }
  if (houses + s.bank.houses !== s.rules.houseSupply) throw new Error(`house supply ${houses}+${s.bank.houses}`);
  if (hotels + s.bank.hotels !== s.rules.hotelSupply) throw new Error('hotel supply');
  for (const p of s.players) {
    if (p.cash < 0 || !Number.isInteger(p.cash)) throw new Error(`bad cash ${p.name} ${p.cash}`);
    if (p.position < 0 || p.position > 39) throw new Error('bad position');
    if (p.bankrupt && (p.cash || p.jailCards.length)) throw new Error('bankrupt holds assets');
  }
  const cards = s.decks.chance.length + s.decks.chest.length + s.players.reduce((n, p) => n + p.jailCards.length, 0);
  if (cards !== CARDS.length) throw new Error(`card count ${cards}`);
  if (s.winner && activePlayers(s).length !== 1) throw new Error('winner with others left');
}

/** Plays random bots until someone wins or the step cap is hit. */
export function simulate(seed: number, players = 3, maxSteps = 6000, rules: Partial<Ruleset> = {}) {
  let s = newGame(players, seed, rules);
  const rng = mulberry(seed * 7919 + 1);
  let steps = 0;
  while (!s.winner && steps < maxSteps) {
    steps++;
    const waiting = waitingOn(s);
    // Sometimes let a player who is not being waited on act (trades, building, mortgages).
    const candidates = rng() < 0.15 ? activePlayers(s).map((p) => p.id) : waiting;
    const by = candidates[Math.floor(rng() * candidates.length)];
    const action = by ? randomBotAction(s, by, rng) : null;
    if (action) {
      const r = applyAction(s, { action, by, seq: steps });
      if ('error' in r) {
        // Bots may build invalid trades; anything else is a bug.
        if (action.type !== 'PROPOSE_TRADE') throw new Error(`seed ${seed} step ${steps}: ${by} ${JSON.stringify(action)} -> ${r.error}`);
        continue;
      }
      s = r.state;
    } else if (rng() < 0.002 && s.pending?.type !== 'auction') {
      // A player walks away mid-game and the host removes them.
      const gone = candidates[0] ?? activePlayers(s)[0].id;
      s = act(s, 'host', { type: 'REMOVE_PLAYER', playerId: gone });
    } else if (s.pending?.type === 'auction' && rng() < 0.3) {
      s = act(s, 'host', { type: 'CLOSE_AUCTION' });
    }
    checkInvariants(s);
  }
  return { state: s, steps };
}
