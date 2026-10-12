import { describe, expect, it } from 'vitest';
import { addToStats, applyAction, HISTORY_MAX, newGameStats, recordTurn, strategyBotAction, type GameState } from '../src';
import { newGame } from './helpers';

describe('statistics', () => {
  it('adds up consistently over a bot game', () => {
    let s: GameState = newGame(3, 7);
    const stats = newGameStats();
    let rentFromEvents = 0;
    for (let step = 0; step < 3000 && !s.winner; step++) {
      // Like the host: the first player with something to do moves.
      let by: string | undefined; let action = null;
      for (const p of s.players) {
        if (p.bankrupt) continue;
        action = strategyBotAction(s, p.id);
        if (action) { by = p.id; break; }
      }
      if (!by || !action) break;
      const r = applyAction(s, { action, by, seq: step + 1 });
      if ('error' in r) throw new Error(r.error);
      s = r.state;
      recordTurn(addToStats(stats, r.events), s);
      for (const e of r.events) if (e.type === 'paid' && e.reason.startsWith('rent on ') && e.to !== 'bank') rentFromEvents += e.amount;
    }
    const all = Object.values(stats.players);
    const sum = (k: keyof (typeof all)[number]) => all.reduce((t, p) => t + p[k], 0);
    expect(sum('rolls')).toBeGreaterThan(50);
    expect(sum('doubles')).toBeLessThan(sum('rolls'));
    expect(sum('rentReceived')).toBe(rentFromEvents);
    expect(sum('rentPaid')).toBe(rentFromEvents);
    expect(sum('propertiesBought')).toBeGreaterThan(0);
    // The graph history: one point per turn, thinned but in order, ending on the current turn.
    expect(stats.history.length).toBeGreaterThan(10);
    expect(stats.history.length).toBeLessThanOrEqual(HISTORY_MAX);
    expect(stats.history.every((h, i, a) => i === 0 || h.turn > a[i - 1].turn)).toBe(true);
    expect(stats.history[stats.history.length - 1].turn).toBe(s.turn.number);
    const last = stats.history[stats.history.length - 1];
    for (const p of s.players) expect(last.rentPaid[p.id]).toBe(stats.players[p.id]?.rentPaid ?? 0);
    expect(Object.values(stats.landings).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(sum('rolls') - sum('timesInJail'));
  });
});
