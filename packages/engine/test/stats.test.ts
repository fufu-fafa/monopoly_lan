import { describe, expect, it } from 'vitest';
import { addToStats, applyAction, newGameStats, strategyBotAction, type GameState } from '../src';
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
      addToStats(stats, r.events);
      for (const e of r.events) if (e.type === 'paid' && e.reason.startsWith('rent on ') && e.to !== 'bank') rentFromEvents += e.amount;
    }
    const all = Object.values(stats.players);
    const sum = (k: keyof (typeof all)[number]) => all.reduce((t, p) => t + p[k], 0);
    expect(sum('rolls')).toBeGreaterThan(50);
    expect(sum('doubles')).toBeLessThan(sum('rolls'));
    expect(sum('rentReceived')).toBe(rentFromEvents);
    expect(sum('rentPaid')).toBe(rentFromEvents);
    expect(sum('propertiesBought')).toBeGreaterThan(0);
    expect(Object.values(stats.landings).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(sum('rolls') - sum('timesInJail'));
  });
});
