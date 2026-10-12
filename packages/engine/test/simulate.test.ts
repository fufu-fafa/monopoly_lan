import { describe, expect, it } from 'vitest';
import { simulate } from './helpers';

describe('simulation', () => {
  it('thousands of random-bot games keep every invariant', () => {
    let finished = 0;
    const N = Number(process.env.SIM_GAMES ?? 300);
    for (let seed = 1; seed <= N; seed++) {
      const players = 2 + (seed % 5);
      const { state } = simulate(seed, players, 6000, { freeParkingJackpot: seed % 2 === 0 });
      if (state.winner) finished++;
    }
    // Random bots are bad at Monopoly, but most games should still reach a winner.
    expect(finished).toBeGreaterThan(N * 0.5);
    console.log(`${finished}/${N} games reached a winner`);
  }, 300_000);
});
