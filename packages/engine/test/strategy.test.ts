import { describe, expect, it } from 'vitest';
import { activePlayers, applyAction, boardLeader, CARDS, groupSpaces, randomBotAction, strategyBotAction, newBotMemory, waitingOn, type BotMemory, type GameState } from '../src';
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
      // Like the server: every other strategy bot is an ally against a board leader.
      if (!mem.has(id)) mem.set(id, newBotMemory({ allies: [...smart].filter((x) => x !== id) }));
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

  describe('when one player controls most of the board', () => {
    const orange = groupSpaces('orange');
    // p2 holds most of the board, including the full green set.
    const bigP2 = (s: GameState) => {
      for (const g of ['lightBlue', 'pink', 'red', 'yellow', 'green'] as const) for (const i of groupSpaces(g)) s.properties[i].ownerId = 'p2';
    };
    const withOrange = (houses: number, cash: number) => (s: GameState) => {
      for (const i of orange) s.properties[i] = { ownerId: 'p1', buildings: houses, mortgaged: false };
      s.bank.houses -= houses * 3;
      s.players.find((p) => p.id === 'p1')!.cash = cash;
    };

    it('recognises the leader', () => {
      expect(boardLeader(setup({}, bigP2))).toBe('p2');
      expect(boardLeader(setup({}, withOrange(0, 1500)))).toBeNull();
    });

    it('goes all in: hotels and every last dollar into houses', () => {
      // Normally it holds at four houses while an opponent has a set.
      const calm = setup({ [groupSpaces('green')[0]]: 'p2', [groupSpaces('green')[1]]: 'p2', [groupSpaces('green')[2]]: 'p2' }, withOrange(4, 1000));
      expect(strategyBotAction(calm, 'p1', newBotMemory())?.type).toBe('ROLL_DICE');
      const s = setup({}, (s) => { bigP2(s); withOrange(4, 1000)(s); });
      expect(strategyBotAction(s, 'p1', newBotMemory())?.type).toBe('BUILD');
      // And spends down to almost nothing, where it would normally keep a cushion.
      const poor = setup({}, (s) => { bigP2(s); withOrange(1, 110)(s); });
      expect(strategyBotAction(poor, 'p1', newBotMemory())?.type).toBe('BUILD');
    });

    it('mortgages loose property to pay for houses', () => {
      const s = setup({ 39: 'p1', 28: 'p1' }, (s) => { bigP2(s); withOrange(2, 20)(s); });
      const a = strategyBotAction(s, 'p1', newBotMemory());
      expect(a?.type).toBe('MORTGAGE');
      expect(a && 'space' in a && [39, 28]).toContain(a && 'space' in a ? a.space : -1);
    });

    it('refuses a trade that only helps the leader', () => {
      const s = setup({ 39: 'p1', 37: 'p2' }, (s) => {
        bigP2(s);
        s.trades.push({ id: 't1', from: 'p2', to: 'p1', give: { cash: 600, properties: [], jailCards: [] }, get: { cash: 0, properties: [39], jailCards: [] } });
      });
      expect(strategyBotAction(s, 'p1', newBotMemory())?.type).toBe('REJECT_TRADE');
    });

    it('refuses a rich offer that would hand the buyer control of the board', () => {
      const s = setup({}, (s) => {
        for (const g of ['lightBlue', 'pink', 'red'] as const) for (const i of groupSpaces(g)) s.properties[i].ownerId = 'p3';
        for (const i of groupSpaces('yellow').slice(0, 2)) s.properties[i].ownerId = 'p3';
        s.properties[groupSpaces('yellow')[2]].ownerId = 'p1';
        for (const i of [5, 15, 25, 35, ...groupSpaces('green'), ...groupSpaces('darkBlue')]) s.properties[i].ownerId = 'p2';
        s.players.find((p) => p.id === 'p3')!.cash = 3000;
      });
      expect(boardLeader(s)).toBeNull();
      const offer = (cash: number) => ({ id: 't1', from: 'p3', to: 'p1', give: { cash, properties: [], jailCards: [] }, get: { cash: 0, properties: [groupSpaces('yellow')[2]], jailCards: [] } });
      s.trades.push(offer(2500));
      expect(strategyBotAction(s, 'p1', newBotMemory())?.type).toBe('REJECT_TRADE');
    });
  });

  describe('basic bots', () => {
    const basic = () => newBotMemory({ advanced: false });
    const [stJames, tennessee] = groupSpaces('orange');

    it('trade one piece at a time and trade jail cards like advanced bots', () => {
      const piece = setup({ [stJames]: 'p1', [tennessee]: 'p2' });
      expect(strategyBotAction(piece, 'p1', basic())).toEqual(strategyBotAction(piece, 'p1', newBotMemory()));
      const card = setup({}, (s) => {
        const id = giveCard(s, 'p2');
        s.trades.push({ id: 't1', from: 'p1', to: 'p2', give: { cash: 60, properties: [], jailCards: [] }, get: { cash: 0, properties: [], jailCards: [id] } });
      });
      expect(strategyBotAction(card, 'p2', basic())?.type).toBe('ACCEPT_TRADE');
    });

    it('do not go all in against a board leader', () => {
      const s = setup({}, (s) => {
        for (const g of ['lightBlue', 'pink', 'red', 'yellow', 'green'] as const) for (const i of groupSpaces(g)) s.properties[i].ownerId = 'p2';
        for (const i of groupSpaces('orange')) s.properties[i] = { ownerId: 'p1', buildings: 4, mortgaged: false };
        s.bank.houses -= 12;
      });
      expect(strategyBotAction(s, 'p1', basic())?.type).toBe('ROLL_DICE');
    });

    it('a mixed table of basic and advanced bots plays to the end', () => {
      for (let seed = 1; seed <= 10; seed++) {
        let s = newGame(4, seed);
        const mem = new Map(s.players.map((p, i) => [p.id, newBotMemory({ advanced: i % 2 === 0 })]));
        for (let step = 0; step < 20000 && !s.winner; step++) {
          let acted = false;
          for (const id of [...new Set([...waitingOn(s), ...activePlayers(s).map((p) => p.id)])]) {
            const a = strategyBotAction(s, id, mem.get(id));
            if (!a) continue;
            const r = applyAction(s, { action: a, by: id, seq: step });
            if ('error' in r) throw new Error(r.error);
            s = r.state;
            acted = true;
            break;
          }
          if (!acted) {
            const r = applyAction(s, { action: { type: 'CLOSE_AUCTION' }, by: 'host', seq: step });
            if ('error' in r) throw new Error('stuck');
            s = r.state;
          }
          checkInvariants(s);
        }
        expect(s.winner).toBeTruthy();
      }
    });
  });

  describe('advanced bots team up against a board leader', () => {
    // p2 controls the board; p1 and p3 are advanced bots and allies.
    const leaderP2 = (s: GameState) => {
      for (const g of ['lightBlue', 'pink', 'red', 'yellow', 'green'] as const) for (const i of groupSpaces(g)) s.properties[i].ownerId = 'p2';
    };
    const ally = (id: string) => newBotMemory({ allies: id === 'p1' ? ['p3'] : ['p1'] });

    it('stay out of an ally\'s auction', () => {
      const s = setup({}, (s) => {
        leaderP2(s);
        s.pending = { type: 'auction', id: 1, space: 39, highBid: 50, highBidder: 'p3', bidders: ['p1', 'p2', 'p3'] };
      });
      expect(strategyBotAction(s, 'p1', ally('p1'))?.type).toBe('PASS_BID');
      expect(strategyBotAction(s, 'p1', newBotMemory())?.type).toBe('BID'); // without the alliance it competes
    });

    it('rescue an ally who would go bankrupt to the leader', () => {
      let s = setup({ 39: 'p3', 37: 'p3' }, (s) => {
        leaderP2(s);
        const p3 = s.players.find((p) => p.id === 'p3')!;
        p3.cash = 0;
        s.debts.push({ debtorId: 'p3', creditor: 'p2', amount: 500, reason: 'rent' });
      });
      // p3 has $375 of mortgages against a $500 debt: it asks p1 for the rest in exchange for a property.
      const ask = strategyBotAction(s, 'p3', ally('p3'));
      expect(ask?.type).toBe('PROPOSE_TRADE');
      const r = applyAction(s, { action: ask!, by: 'p3', seq: 1 });
      if ('error' in r) throw new Error(r.error);
      s = r.state;
      expect(strategyBotAction(s, 'p3', ally('p3'))).toBeNull(); // waits for the answer
      expect(strategyBotAction(s, 'p1', ally('p1'))?.type).toBe('ACCEPT_TRADE');
      // Without allies, it goes bankrupt instead.
      const alone = setup({ 39: 'p3', 37: 'p3' }, (s) => {
        leaderP2(s);
        s.players.find((p) => p.id === 'p3')!.cash = 0;
        s.debts.push({ debtorId: 'p3', creditor: 'p2', amount: 500, reason: 'rent' });
      });
      expect(strategyBotAction(alone, 'p3', newBotMemory())?.type).toBe('DECLARE_BANKRUPTCY');
    });

    // p3 is the stronger ally, so it is the champion.
    const strongP3 = (s: GameState) => { leaderP2(s); s.players.find((p) => p.id === 'p3')!.cash = 5000; };

    it('pour everything into the strongest ally', () => {
      const s = setup({ 39: 'p1', 5: 'p1' }, (s) => { strongP3(s); giveCard(s, 'p1'); });
      const a = strategyBotAction(s, 'p1', ally('p1'));
      expect(a?.type).toBe('PROPOSE_TRADE');
      if (a?.type !== 'PROPOSE_TRADE') return;
      expect(a.offer.to).toBe('p3');
      expect(a.offer.give).toEqual({ cash: 1500, properties: [5, 39], jailCards: [s.players[0].jailCards[0]] });
      expect(a.offer.get).toEqual({ cash: 0, properties: [], jailCards: [] });
      // The champion takes it.
      const r = applyAction(s, { action: a, by: 'p1', seq: 1 });
      if ('error' in r) throw new Error(r.error);
      expect(strategyBotAction(r.state, 'p3', ally('p3'))?.type).toBe('ACCEPT_TRADE');
      // A bot outside the alliance keeps its things.
      expect(strategyBotAction(s, 'p1', newBotMemory())?.type).toBe('ROLL_DICE');
    });

    it('sell buildings first so the sets can move to the champion', () => {
      const s = setup({}, (s) => {
        strongP3(s);
        for (const i of groupSpaces('orange')) s.properties[i] = { ownerId: 'p1', buildings: 2, mortgaged: false };
        s.bank.houses -= 6;
      });
      expect(strategyBotAction(s, 'p1', ally('p1'))?.type).toBe('SELL_BUILDING');
    });

    it('leave auctions to the champion', () => {
      const s = setup({}, (s) => {
        strongP3(s);
        s.pending = { type: 'auction', id: 1, space: 39, highBid: 50, highBidder: 'p2', bidders: ['p1', 'p2', 'p3'] };
      });
      expect(strategyBotAction(s, 'p1', ally('p1'))?.type).toBe('PASS_BID');
      expect(strategyBotAction(s, 'p3', ally('p3'))?.type).toBe('BID');
    });

    it('accept a deal that costs a little but helps the alliance more', () => {
      const [stJames, tennessee, newYork] = groupSpaces('orange');
      const s = setup({ [stJames]: 'p3', [tennessee]: 'p3', [newYork]: 'p1' }, (s) => {
        leaderP2(s);
        // p3 offers $150 for New York Avenue, which completes their orange set.
        s.trades.push({ id: 't1', from: 'p3', to: 'p1', give: { cash: 150, properties: [], jailCards: [] }, get: { cash: 0, properties: [newYork], jailCards: [] } });
      });
      expect(strategyBotAction(s, 'p1', ally('p1'))?.type).toBe('ACCEPT_TRADE');
      expect(strategyBotAction(s, 'p1', newBotMemory())?.type).toBe('REJECT_TRADE');
    });
  });
});
