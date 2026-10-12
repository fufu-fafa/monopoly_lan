import { describe, expect, it } from 'vitest';
import { activePlayers, applyAction, CARDS, groupSpaces, randomBotAction, strategyBotAction, newBotMemory, waitingOn, type BotMemory, type GameState } from '../src';
import { checkInvariants, mulberry, newGame } from './helpers';

/** Plays a game where players listed in `smart` use the strategy bot and the rest the random bot. */
function play(seed: number, players: number, smart: Set<string>, maxSteps = 20000) {
  let s: GameState = newGame(players, seed);
  const rng = mulberry(seed * 31 + 7);
  const mem = new Map<string, BotMemory>();
  let steps = 0;
  let trades = 0;
  while (!s.winner && steps < maxSteps) {
    steps++;
    let acted = false;
    // Everyone gets a chance to act, the players being waited on first.
    const order = [...new Set([...waitingOn(s), ...activePlayers(s).map((p) => p.id)])];
    for (const id of order) {
      if (!mem.has(id)) mem.set(id, newBotMemory());
      let a = smart.has(id) ? strategyBotAction(s, id, mem.get(id)) : null;
      // The random bot sometimes picks nothing or a junk trade; let it draw again.
      for (let i = 0; !smart.has(id) && waitingOn(s).includes(id) && i < 20 && (!a || a.type === 'PROPOSE_TRADE'); i++) a = randomBotAction(s, id, rng);
      if (!a || (!smart.has(id) && a.type === 'PROPOSE_TRADE')) continue;
      const r = applyAction(s, { action: a, by: id, seq: steps });
      if ('error' in r) {
        if (!smart.has(id)) continue;
        throw new Error(`seed ${seed}: ${id} ${JSON.stringify(a)} -> ${r.error}`);
      }
      if (a.type === 'ACCEPT_TRADE') trades++;
      s = r.state;
      acted = true;
      break;
    }
    if (!acted && s.pending?.type === 'auction') {
      const r = applyAction(s, { action: { type: 'CLOSE_AUCTION' }, by: 'host', seq: steps });
      if (!('error' in r)) { s = r.state; acted = true; }
    }
    if (!acted) throw new Error(`seed ${seed}: stuck at step ${steps}`);
    checkInvariants(s);
  }
  return { s, steps, trades };
}

describe('strategy bot', () => {
  it('beats random bots most of the time', () => {
    let wins = 0, done = 0;
    const N = 60;
    for (let seed = 1; seed <= N; seed++) {
      const { s } = play(seed, 3, new Set(['p1']));
      if (s.winner) done++;
      if (s.winner === 'p1') wins++;
    }
    console.log(`strategy bot won ${wins}/${N} three-player games against random bots (${done} finished)`);
    expect(wins).toBeGreaterThan(N * 0.6);
  }, 300_000);

  it('plays full games against itself, trading and finishing', () => {
    let done = 0, trades = 0, steps = 0;
    const N = 40;
    for (let seed = 1; seed <= N; seed++) {
      const players = 2 + (seed % 4);
      const r = play(seed, players, new Set(Array.from({ length: players }, (_, i) => `p${i + 1}`)));
      if (r.s.winner) done++;
      trades += r.trades;
      steps += r.steps;
    }
    console.log(`bot-only games: ${done}/${N} finished, ${trades} trades, ${Math.round(steps / N)} actions per game`);
    expect(done).toBeGreaterThan(N * 0.8);
    expect(trades).toBeGreaterThan(0);
  }, 300_000);

  // Sets up a fresh 3-player game on p1's turn, before the roll.
  const setup = (own: Record<number, string>, tweak?: (s: GameState) => void) => {
    const s = newGame(3, 5);
    s.turn.playerId = 'p1';
    for (const [i, owner] of Object.entries(own)) s.properties[Number(i)].ownerId = owner;
    tweak?.(s);
    return s;
  };
  const proposal = (s: GameState) => {
    const a = strategyBotAction(s, 'p1', newBotMemory());
    return a?.type === 'PROPOSE_TRADE' ? a.offer : null;
  };
  const giveCard = (s: GameState, pid: string) => {
    const id = CARDS.find((c) => c.effect.type === 'getOutOfJailFree')!.id;
    s.decks.chance = s.decks.chance.filter((c) => c !== id);
    s.decks.chest = s.decks.chest.filter((c) => c !== id);
    s.players.find((p) => p.id === pid)!.jailCards.push(id);
    return id;
  };
  const [stJames, tennessee, newYork] = groupSpaces('orange');
  // Most of the board owned, so the stage is past the opening.
  const filler = (s: GameState) => {
    for (const g of ['brown', 'lightBlue', 'pink', 'yellow', 'green', 'darkBlue'] as const) for (const i of groupSpaces(g)) s.properties[i].ownerId ??= 'p3';
  };

  it('trades for a piece of a set split among three players', () => {
    const s = setup({ [stJames]: 'p1', [tennessee]: 'p2', [newYork]: 'p3' }, filler);
    const offer = proposal(s);
    expect(offer).not.toBeNull();
    expect(offer!.get.properties.some((i) => i === tennessee || i === newYork)).toBe(true);
  });

  it('trades for a piece of a set whose last piece the bank still holds', () => {
    const s = setup({ [stJames]: 'p1', [tennessee]: 'p2' }, filler);
    const offer = proposal(s);
    expect(offer?.to).toBe('p2');
    expect(offer!.get.properties).toEqual([tennessee]);
  });

  it('buys a Get Out of Jail Free card while stuck in jail early', () => {
    const s = setup({}, (s) => {
      const me = s.players.find((p) => p.id === 'p1')!;
      me.inJail = true;
      me.position = 10;
      giveCard(s, 'p2');
    });
    const offer = proposal(s);
    expect(offer?.to).toBe('p2');
    expect(offer!.get.jailCards.length).toBe(1);
    expect(offer!.give.cash).toBeGreaterThan(0);
  });

  it('sells its Get Out of Jail Free card when short of cash', () => {
    const s = setup({}, (s) => {
      giveCard(s, 'p1');
      s.players.find((p) => p.id === 'p1')!.cash = 40;
    });
    const offer = proposal(s);
    expect(offer!.give.jailCards.length).toBe(1);
    expect(offer!.get.cash).toBeGreaterThan(0);
  });

  it('accepts a fair cash offer for its jail card and rejects a lowball', () => {
    for (const [cash, accept] of [[60, true], [5, false]] as const) {
      const s = setup({}, (s) => {
        const id = giveCard(s, 'p2');
        s.trades.push({ id: 't1', from: 'p1', to: 'p2', give: { cash, properties: [], jailCards: [] }, get: { cash: 0, properties: [], jailCards: [id] } });
      });
      expect(strategyBotAction(s, 'p2', newBotMemory())?.type).toBe(accept ? 'ACCEPT_TRADE' : 'REJECT_TRADE');
    }
  });
});
