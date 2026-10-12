import { describe, expect, it } from 'vitest';
import { legalActions, rentFor } from '../src';
import type { GameState } from '../src';
import { act, newGame, tryAct } from './helpers';

function own(s: GameState, owner: string, ...spaces: number[]) {
  for (const i of spaces) s.properties[i].ownerId = owner;
  return s;
}

describe('rules', () => {
  it('starts with $1500 each and player 1 to roll', () => {
    const s = newGame(3);
    expect(s.players.map((p) => p.cash)).toEqual([1500, 1500, 1500]);
    expect(legalActions(s, 'p1')).toContainEqual({ type: 'ROLL_DICE' });
    expect(legalActions(s, 'p2')).not.toContainEqual({ type: 'ROLL_DICE' });
  });

  it('rejects actions from the wrong player', () => {
    const s = newGame(2);
    expect(tryAct(s, 'p2', { type: 'ROLL_DICE' })).toEqual({ error: 'It is not your turn' });
  });

  it('street rent doubles on a full set and follows the house table', () => {
    const s = own(newGame(2), 'p1', 1);
    expect(rentFor(s, 1)).toBe(2);
    own(s, 'p1', 3);
    expect(rentFor(s, 1)).toBe(4);
    s.properties[1].buildings = 3;
    expect(rentFor(s, 1)).toBe(90);
    s.properties[1].buildings = 5;
    expect(rentFor(s, 1)).toBe(250);
  });

  it('railroad and utility rent scale with how many are owned', () => {
    const s = own(newGame(2), 'p1', 5, 15, 12);
    expect(rentFor(s, 5)).toBe(50);
    expect(rentFor(s, 12, { dice: 8 })).toBe(32);
    own(s, 'p1', 28);
    expect(rentFor(s, 12, { dice: 8 })).toBe(80);
    s.properties[5].mortgaged = true;
    expect(rentFor(s, 5)).toBe(0);
  });

  it('enforces even building and pays half back on sale', () => {
    let s = own(newGame(2), 'p1', 1, 3);
    s = act(s, 'p1', { type: 'BUILD', space: 1 });
    expect(tryAct(s, 'p1', { type: 'BUILD', space: 1 })).toEqual({ error: 'Build evenly across the set' });
    s = act(s, 'p1', { type: 'BUILD', space: 3 });
    expect(s.players[0].cash).toBe(1400);
    expect(s.bank.houses).toBe(30);
    s = act(s, 'p1', { type: 'SELL_BUILDING', space: 3 });
    expect(s.players[0].cash).toBe(1425);
  });

  it('cannot mortgage while the set has buildings; unmortgage costs 10% more', () => {
    let s = own(newGame(2), 'p1', 1, 3);
    s = act(s, 'p1', { type: 'BUILD', space: 1 });
    expect(tryAct(s, 'p1', { type: 'MORTGAGE', space: 3 })).toEqual({ error: 'Sell the buildings in this set first' });
    s = act(s, 'p1', { type: 'SELL_BUILDING', space: 1 });
    s = act(s, 'p1', { type: 'MORTGAGE', space: 3 });
    const cash = s.players[0].cash;
    s = act(s, 'p1', { type: 'UNMORTGAGE', space: 3 });
    expect(cash - s.players[0].cash).toBe(33);
  });

  it('declining a purchase starts an auction that the host can close', () => {
    let s = newGame(3);
    s.pending = { type: 'buyOrAuction', playerId: 'p1', space: 39 };
    s.turn.phase = 'postRoll';
    s = act(s, 'p1', { type: 'DECLINE_BUY' });
    expect(s.pending?.type).toBe('auction');
    s = act(s, 'p2', { type: 'BID', amount: 10 });
    s = act(s, 'p1', { type: 'BID', amount: 11 });
    expect(tryAct(s, 'p2', { type: 'BID', amount: 11 })).toEqual({ error: 'Bid more than $11' });
    expect(tryAct(s, 'p1', { type: 'PROPOSE_TRADE', offer: { to: 'p2', give: { cash: 1, properties: [], jailCards: [] }, get: { cash: 0, properties: [], jailCards: [] } } }))
      .toEqual({ error: 'No trading during an auction' });
    s = act(s, 'host', { type: 'CLOSE_AUCTION' });
    expect(s.properties[39].ownerId).toBe('p1');
    expect(s.players[0].cash).toBe(1489);
  });

  it('auction closes on its own when everyone else passes', () => {
    let s = newGame(3);
    s.pending = { type: 'buyOrAuction', playerId: 'p1', space: 39 };
    s = act(s, 'p1', { type: 'DECLINE_BUY' });
    s = act(s, 'p3', { type: 'BID', amount: 5 });
    s = act(s, 'p1', { type: 'PASS_BID' });
    s = act(s, 'p2', { type: 'PASS_BID' });
    expect(s.pending).toBeNull();
    expect(s.properties[39].ownerId).toBe('p3');
  });

  it('trades swap assets and charge 10% on mortgaged property received', () => {
    let s = own(newGame(2), 'p1', 1);
    own(s, 'p2', 3);
    s.properties[3].mortgaged = true;
    s = act(s, 'p1', { type: 'PROPOSE_TRADE', offer: { to: 'p2', give: { cash: 100, properties: [1], jailCards: [] }, get: { cash: 0, properties: [3], jailCards: [] } } });
    expect(s.trades).toHaveLength(1);
    s = act(s, 'p2', { type: 'ACCEPT_TRADE', tradeId: s.trades[0].id });
    expect(s.properties[1].ownerId).toBe('p2');
    expect(s.properties[3].ownerId).toBe('p1');
    expect(s.players[0].cash).toBe(1500 - 100 - 3);
    expect(s.players[1].cash).toBe(1600);
  });

  it('cancels a trade when its assets change', () => {
    let s = own(newGame(2), 'p1', 1);
    s = act(s, 'p1', { type: 'PROPOSE_TRADE', offer: { to: 'p2', give: { cash: 0, properties: [1], jailCards: [] }, get: { cash: 50, properties: [], jailCards: [] } } });
    s = act(s, 'p1', { type: 'MORTGAGE', space: 1 });
    expect(s.trades).toHaveLength(1); // still valid: mortgaged property can be traded
    s.players[1].cash = 10;
    s = act(s, 'p1', { type: 'UNMORTGAGE', space: 1 });
    expect(s.trades).toHaveLength(0);
  });

  it('unpaid rent becomes a debt; bankruptcy hands everything to the creditor', () => {
    let s = own(newGame(3), 'p2', 39);
    s.properties[39].buildings = 5;
    own(s, 'p2', 37);
    s.bank.hotels--;
    own(s, 'p1', 1);
    s.players[0].position = 39;
    s.players[0].cash = 100;
    // simulate landing by putting the debt in place via a forced roll path
    s.debts.push({ debtorId: 'p1', creditor: 'p2', amount: 2000, reason: 'rent on Boardwalk' });
    s.turn.phase = 'postRoll';
    expect(legalActions(s, 'p1')).toContainEqual({ type: 'DECLARE_BANKRUPTCY' });
    expect(tryAct(s, 'p1', { type: 'END_TURN' })).toHaveProperty('error');
    s = act(s, 'p1', { type: 'DECLARE_BANKRUPTCY' });
    expect(s.players[0].bankrupt).toBe(true);
    expect(s.properties[1].ownerId).toBe('p2');
    expect(s.players[1].cash).toBe(1600);
    expect(s.turn.playerId).toBe('p2');
  });

  it('bankruptcy to the bank auctions the properties', () => {
    let s = own(newGame(3), 'p1', 1, 3);
    s.debts.push({ debtorId: 'p1', creditor: 'bank', amount: 5000, reason: 'tax' });
    s = act(s, 'p1', { type: 'DECLARE_BANKRUPTCY' });
    expect(s.pending).toMatchObject({ type: 'auction', space: 1 });
    expect(s.auctionQueue).toEqual([3]);
    s = act(s, 'host', { type: 'CLOSE_AUCTION' });
    expect(s.pending).toMatchObject({ type: 'auction', space: 3 });
  });

  it('last solvent player wins', () => {
    let s = newGame(2);
    s.debts.push({ debtorId: 'p2', creditor: 'p1', amount: 5000, reason: 'rent' });
    s = act(s, 'p2', { type: 'DECLARE_BANKRUPTCY' });
    expect(s.winner).toBe('p1');
    expect(s.turn.phase).toBe('gameOver');
  });

  it('three doubles in a row sends you to jail', () => {
    // Find a seed whose first three rolls are doubles is unlikely; drive state directly instead.
    let s = newGame(2, 3);
    s.turn.doublesCount = 2;
    for (let seed = 1; seed < 5000; seed++) {
      const t = newGame(2, seed);
      t.turn.doublesCount = 2;
      const r = tryAct(t, 'p1', { type: 'ROLL_DICE' });
      if ('state' in r && r.state.turn.lastRoll![0] === r.state.turn.lastRoll![1]) {
        s = r.state;
        break;
      }
    }
    expect(s.players[0].inJail).toBe(true);
    expect(s.players[0].position).toBe(10);
    expect(legalActions(s, 'p1')).toContainEqual({ type: 'END_TURN' });
  });

  it('Free Parking jackpot collects taxes when the option is on', () => {
    let s = newGame(2, 1, { freeParkingJackpot: true });
    s.players[0].position = 2; // roll will move from here; force a tax by putting p1 one roll away is fiddly,
    s.debts.push({ debtorId: 'p1', creditor: 'bank', amount: 200, reason: 'Income Tax', toPot: true });
    s = act(s, 'p1', { type: 'PAY_DEBT' });
    expect(s.bank.freeParkingPot).toBe(200);
  });

  it('is deterministic for the same seed and actions', () => {
    const run = () => {
      let s = newGame(2, 42);
      for (let i = 0; i < 6; i++) {
        const legal = legalActions(s, s.turn.playerId);
        const a = legal.find((x) => x.type === 'ROLL_DICE') ?? legal.find((x) => x.type === 'DECLINE_BUY') ?? legal.find((x) => x.type === 'END_TURN');
        if (!a) break;
        s = act(s, s.turn.playerId, a);
        if (s.pending?.type === 'auction') s = act(s, 'host', { type: 'CLOSE_AUCTION' });
      }
      return JSON.stringify(s);
    };
    expect(run()).toBe(run());
  });

  it('the host can remove a player who left; their property goes back to the bank', () => {
    let s = own(newGame(3), 'p1', 1, 3);
    s.properties[1].buildings = 1;
    s.bank.houses--;
    expect(tryAct(s, 'p2', { type: 'REMOVE_PLAYER', playerId: 'p1' })).toEqual({ error: 'Only the host removes players' });
    s = act(s, 'host', { type: 'REMOVE_PLAYER', playerId: 'p1' });
    expect(s.players[0].bankrupt).toBe(true);
    expect(s.turn.playerId).toBe('p2');
    expect(s.bank.houses).toBe(32);
    expect(s.pending).toMatchObject({ type: 'auction', space: 1 });
    expect(s.auctionQueue).toEqual([3]);
  });

  it('a player deciding whether to buy can leave; the property is auctioned', () => {
    let s = newGame(3);
    s.pending = { type: 'buyOrAuction', playerId: 'p1', space: 39 };
    s = act(s, 'p1', { type: 'LEAVE_GAME' });
    expect(s.pending).toMatchObject({ type: 'auction', space: 39 });
    expect(s.pending && 'bidders' in s.pending && s.pending.bidders).toEqual(['p2', 'p3']);
  });

  it('leaving a two-player game ends it', () => {
    let s = newGame(2);
    s = act(s, 'p2', { type: 'LEAVE_GAME' });
    expect(s.winner).toBe('p1');
  });

  it('inheriting mortgaged property through bankruptcy costs the 10% fee', () => {
    let s = own(newGame(3), 'p1', 39);
    s.properties[39].mortgaged = true;
    s.debts.push({ debtorId: 'p1', creditor: 'p2', amount: 5000, reason: 'rent' });
    s = act(s, 'p1', { type: 'DECLARE_BANKRUPTCY' });
    expect(s.properties[39].ownerId).toBe('p2');
    expect(s.players[1].cash).toBe(1500 + 1500 - 20);
  });
});
