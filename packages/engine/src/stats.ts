import type { GameEvent, GameState, PlayerId } from './types';
import { netWorth } from './selectors';

/** Running totals for one player, built from game events. */
export interface PlayerStats {
  rolls: number;
  doubles: number;
  passedGo: number;
  propertiesBought: number;
  rentPaid: number;
  rentReceived: number;
  taxesAndFees: number; // taxes, jail fines, repairs and card payments to the bank
  spentOnBuildings: number;
  timesInJail: number;
  cardsDrawn: number;
}

export interface GameStats {
  players: Record<PlayerId, PlayerStats>;
  /** How often a token ended a move on each space. */
  landings: Record<number, number>;
  /** One point per turn (thinned to at most HISTORY_MAX), for the graphs. */
  history: HistoryPoint[];
}

export interface HistoryPoint {
  turn: number;
  netWorth: Record<PlayerId, number>; // 0 once a player is out
  rentReceived: Record<PlayerId, number>;
  rentPaid: Record<PlayerId, number>;
}

export const HISTORY_MAX = 120;

export const newGameStats = (): GameStats => ({ players: {}, landings: {}, history: [] });

const empty = (): PlayerStats => ({
  rolls: 0, doubles: 0, passedGo: 0, propertiesBought: 0, rentPaid: 0, rentReceived: 0,
  taxesAndFees: 0, spentOnBuildings: 0, timesInJail: 0, cardsDrawn: 0,
});

/** Adds one action's events to the totals, in place. Pure bookkeeping: the rules never read it. */
export function addToStats(stats: GameStats, events: GameEvent[]): GameStats {
  const p = (id: PlayerId) => (stats.players[id] ??= empty());
  for (const e of events) {
    switch (e.type) {
      case 'diceRolled':
        p(e.playerId).rolls++;
        if (e.dice[0] === e.dice[1]) p(e.playerId).doubles++;
        break;
      case 'moved':
        stats.landings[e.to] = (stats.landings[e.to] ?? 0) + 1;
        if (e.passedGo) p(e.playerId).passedGo++;
        break;
      case 'sentToJail':
        p(e.playerId).timesInJail++;
        break;
      case 'cardDrawn':
        p(e.playerId).cardsDrawn++;
        break;
      case 'paid': {
        if (e.from === 'bank') break;
        const from = p(e.from);
        if (e.reason.startsWith('rent on ')) {
          from.rentPaid += e.amount;
          if (e.to !== 'bank') p(e.to).rentReceived += e.amount;
        } else if (e.reason.startsWith('bought ') || e.reason.startsWith('won ')) {
          from.propertiesBought++;
        } else if (e.reason.startsWith('building on ')) {
          from.spentOnBuildings += e.amount;
        } else if (e.to === 'bank' && !e.reason.startsWith('unmortgaged ') && e.reason !== 'bankruptcy') {
          from.taxesAndFees += e.amount;
        }
        break;
      }
    }
  }
  return stats;
}

/**
 * Records where everyone stands at the start of a turn. Call it after each action; it only adds a point
 * when the turn number has moved on. Long games are thinned by dropping every other older point.
 */
export function recordTurn(stats: GameStats, s: GameState): GameStats {
  const last = stats.history[stats.history.length - 1];
  if (last && last.turn === s.turn.number && !s.winner) return stats;
  const point: HistoryPoint = { turn: s.turn.number, netWorth: {}, rentReceived: {}, rentPaid: {} };
  for (const p of s.players) {
    point.netWorth[p.id] = p.bankrupt ? 0 : netWorth(s, p.id);
    point.rentReceived[p.id] = stats.players[p.id]?.rentReceived ?? 0;
    point.rentPaid[p.id] = stats.players[p.id]?.rentPaid ?? 0;
  }
  if (last && last.turn === s.turn.number) stats.history[stats.history.length - 1] = point; // final position
  else stats.history.push(point);
  if (stats.history.length > HISTORY_MAX) {
    // Keep the first and the newest points, drop every other one in between.
    stats.history = stats.history.filter((_, i, a) => i === 0 || i === a.length - 1 || i % 2 === 0);
  }
  return stats;
}
