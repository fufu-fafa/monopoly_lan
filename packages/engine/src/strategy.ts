import { legalActions } from './legal';
import {
  activePlayers, debtsOf, getPlayer, groupSpaces, ownedProperties, ownsFullSet, propertySpace, rentFor,
  setHasBuildings, totalDebt, tradesBlocked, unmortgageCost, whyAssetsInvalid,
} from './selectors';
import type { Action, Assets, ColorGroup, GameState, PlayerId, TradeOffer } from './types';

/**
 * Computer player. It plays the well-known winning habits:
 * - buy aggressively early and keep property flowing through auctions;
 * - value orange and red highest (Jail feeds them), green is a slower long game;
 * - build every set to three houses first, then four, and sit on four houses
 *   (no hotels) while that starves opponents of the 32 houses;
 * - railroads yes, utilities only as cheap trade bait;
 * - trade to complete sets, never hand over a monopoly without equal value back,
 *   and buy strays that block an opponent's set;
 * - leave jail fast early, stay in jail once the board is developed;
 * - keep a cash cushion sized to the worst rent on the board.
 * Each call returns one action (or null when there is nothing to do); the caller loops.
 */

export interface BotMemory {
  proposed: Set<string>; // trades already offered, so a bot never repeats itself
  lastTradeTurn: number;
  tradeSeen: Map<string, number>; // own open offers -> turn first seen
}

export function newBotMemory(): BotMemory {
  return { proposed: new Set(), lastTradeTurn: -1, tradeSeen: new Map() };
}

const GROUPS: ColorGroup[] = ['orange', 'red', 'yellow', 'pink', 'lightBlue', 'green', 'darkBlue', 'brown'];
// How much a complete set is worth relative to its list price.
const SET_WEIGHT: Record<ColorGroup, number> = {
  orange: 2.5, red: 2.3, yellow: 2.0, pink: 2.0, lightBlue: 1.9, green: 1.8, darkBlue: 1.9, brown: 1.4,
};
const RAIL_VALUE = [0, 200, 450, 750, 1100];
const UTIL_VALUE = [0, 100, 280]; // below the $150 list price: not worth buying outright

type Owners = Record<number, PlayerId | null>;
type SpaceAction = Extract<Action, { space: number }>;

function ownersOf(s: GameState): Owners {
  const o: Owners = {};
  for (const [k, p] of Object.entries(s.properties)) o[Number(k)] = p.ownerId;
  return o;
}

/** What a player's property is worth to them under a (possibly hypothetical) ownership map. */
function holdingsValue(s: GameState, owners: Owners, pid: PlayerId): number {
  let v = 0;
  let rails = 0;
  let utils = 0;
  for (const [k, owner] of Object.entries(owners)) {
    if (owner !== pid) continue;
    const i = Number(k);
    const sp = propertySpace(i)!;
    const prop = s.properties[i];
    if (prop.mortgaged) v -= Math.ceil(sp.mortgage * (1 + s.rules.mortgageInterest));
    if (sp.kind !== 'street') {
      if (sp.kind === 'railroad') rails++;
      else utils++;
      continue;
    }
    const group = groupSpaces(sp.group);
    const n = group.filter((g) => owners[g] === pid).length;
    const mult = n === group.length ? SET_WEIGHT[sp.group] : n === group.length - 1 ? 1.15 : 1;
    v += sp.price * mult + prop.buildings * sp.houseCost;
  }
  return v + RAIL_VALUE[rails] + UTIL_VALUE[utils];
}

/** Value to `pid` of gaining property `i`, plus half of what it denies the opponent who wants it most. */
function propertyWorth(s: GameState, pid: PlayerId, i: number): { mine: number; block: number } {
  const owners = ownersOf(s);
  const without = { ...owners, [i]: null };
  const mine = holdingsValue(s, { ...without, [i]: pid }, pid) - holdingsValue(s, without, pid);
  const price = propertySpace(i)!.price;
  let block = 0;
  for (const o of activePlayers(s)) {
    if (o.id === pid) continue;
    const theirs = holdingsValue(s, { ...without, [i]: o.id }, o.id) - holdingsValue(s, without, o.id);
    block = Math.max(block, (theirs - price) * 0.5);
  }
  return { mine, block };
}

function opponentRents(s: GameState, me: PlayerId): number[] {
  const out: number[] = [];
  for (const [k, prop] of Object.entries(s.properties)) {
    if (!prop.ownerId || prop.ownerId === me) continue;
    out.push(rentFor(s, Number(k), { dice: 7 }));
  }
  return out.sort((a, b) => b - a);
}

/** Cash to keep on hand: enough to survive a bad landing without breaking up a developed set. */
function cushion(s: GameState, me: PlayerId): number {
  const r = opponentRents(s, me);
  return Math.min(900, Math.max(60, Math.round((r[0] ?? 0) * 0.6 + (r[1] ?? 0) * 0.2)));
}

function opponentBuildings(s: GameState, me: PlayerId): number {
  let n = 0;
  for (const prop of Object.values(s.properties)) if (prop.ownerId && prop.ownerId !== me) n += prop.buildings;
  return n;
}

function unownedCount(s: GameState): number {
  return Object.values(s.properties).filter((p) => !p.ownerId).length;
}

/** Cash a player could raise from mortgages of loose property (not part of a complete set). */
function spareMortgage(s: GameState, me: PlayerId): number {
  let n = 0;
  for (const i of ownedProperties(s, me)) {
    const sp = propertySpace(i)!;
    const prop = s.properties[i];
    if (prop.mortgaged) continue;
    if (sp.kind === 'street' && ownsFullSet(s, me, sp.group)) continue;
    n += sp.mortgage;
  }
  return n;
}

function liquidationValue(s: GameState, me: PlayerId): number {
  let n = getPlayer(s, me)!.cash;
  for (const i of ownedProperties(s, me)) {
    const sp = propertySpace(i)!;
    const prop = s.properties[i];
    if (!prop.mortgaged) n += sp.mortgage;
    if (sp.kind === 'street') n += (prop.buildings * sp.houseCost) / 2;
  }
  return n;
}

const groupRank = (g: ColorGroup) => GROUPS.indexOf(g);

// ------------------------------------------------------------------ entry point

export function strategyBotAction(s: GameState, me: PlayerId, mem: BotMemory = newBotMemory()): Action | null {
  const p = getPlayer(s, me);
  if (!p || p.bankrupt || s.winner) return null;
  const legal = legalActions(s, me);
  const has = (t: Action['type']) => legal.some((a) => a.type === t);

  if (s.pending?.type === 'auction') return auctionAction(s, me, legal);

  if (debtsOf(s, me).length) return raiseMoney(s, me, legal);

  for (const t of s.trades) {
    if (t.to !== me) continue;
    const accept = legal.some((a) => a.type === 'ACCEPT_TRADE' && a.tradeId === t.id) && wouldAccept(s, t);
    return { type: accept ? 'ACCEPT_TRADE' : 'REJECT_TRADE', tradeId: t.id };
  }

  if (s.pending?.type === 'buyOrAuction' && s.pending.playerId === me) {
    return has('BUY') && shouldBuy(s, me, s.pending.space) ? { type: 'BUY' } : { type: 'DECLINE_BUY' };
  }

  if (s.pending || s.turn.playerId !== me) return null;

  // Own turn: tidy up offers nobody answered, then manage, trade, and roll.
  for (const t of s.trades) {
    if (t.from !== me) continue;
    if (!mem.tradeSeen.has(t.id)) mem.tradeSeen.set(t.id, s.turn.number);
    if (s.turn.number - mem.tradeSeen.get(t.id)! >= activePlayers(s).length) return { type: 'WITHDRAW_TRADE', tradeId: t.id };
  }

  const manage = unmortgageAction(s, me, legal) ?? buildAction(s, me, legal);
  if (manage) return manage;

  if (s.turn.phase === 'preRoll') {
    const trade = tradeAction(s, me, mem);
    if (trade) return trade;
    if (p.inJail && !stayInJail(s, me)) {
      if (has('USE_JAIL_CARD')) return { type: 'USE_JAIL_CARD' };
      if (has('PAY_JAIL_FINE') && p.cash - s.rules.jailFine >= 40) return { type: 'PAY_JAIL_FINE' };
    }
  }
  if (has('ROLL_DICE')) return { type: 'ROLL_DICE' };
  if (has('END_TURN')) return { type: 'END_TURN' };
  return null;
}

// ------------------------------------------------------------------ buying and auctions

function shouldBuy(s: GameState, me: PlayerId, i: number): boolean {
  const price = propertySpace(i)!.price;
  const { mine, block } = propertyWorth(s, me, i);
  if (mine + block < price) return false; // a lone utility, mostly: let it go to auction cheaply
  const cash = getPlayer(s, me)!.cash;
  if (cash - price >= cushion(s, me) * 0.5) return true;
  // Short of a cushion: still buy what completes or blocks a set, since loose property can be mortgaged.
  return mine + block >= price * 1.3 && cash - price + spareMortgage(s, me) >= cushion(s, me) * 0.5;
}

function auctionAction(s: GameState, me: PlayerId, legal: Action[]): Action | null {
  const a = s.pending;
  if (a?.type !== 'auction' || !a.bidders.includes(me) || a.highBidder === me) return null;
  const sp = propertySpace(a.space)!;
  const cash = getPlayer(s, me)!.cash;
  const { mine, block } = propertyWorth(s, me, a.space);
  const completes = mine >= sp.price * 1.3;
  const keep = completes ? 20 : Math.round(cushion(s, me) * 0.5);
  const limit = Math.floor(Math.min(mine + block, cash - keep));
  const canBid = legal.some((x) => x.type === 'BID');
  if (!canBid || a.highBid + 1 > limit) return legal.some((x) => x.type === 'PASS_BID') ? { type: 'PASS_BID' } : null;
  const opening = Math.max(10, Math.round(sp.price * 0.4));
  const step = Math.max(5, Math.round(sp.price * 0.1));
  const amount = a.highBidder ? Math.min(limit, a.highBid + step) : Math.min(limit, Math.max(a.highBid + 1, opening));
  return { type: 'BID', amount };
}

// ------------------------------------------------------------------ building and mortgages

function buildAction(s: GameState, me: PlayerId, legal: Action[]): Action | null {
  const builds = legal.filter((a): a is SpaceAction => a.type === 'BUILD');
  if (!builds.length) return null;
  const cash = getPlayer(s, me)!.cash;
  const spare = spareMortgage(s, me) * 0.5;
  const reserve = cushion(s, me);
  // Never trade four houses for a hotel while an opponent has a set that needs houses.
  const opponentSet = activePlayers(s).some((o) => o.id !== me && GROUPS.some((g) => ownsFullSet(s, o.id, g)));

  const options = builds.map((a) => {
    const sp = propertySpace(a.space)!;
    if (sp.kind !== 'street') return null;
    const level = s.properties[a.space].buildings;
    if (level >= 4 && opponentSet) return null;
    // Rush every set to three houses (the best return), then four, then hotels.
    const tier = level < 3 ? 0 : level < 4 ? 1 : 2;
    const need = tier === 0 ? reserve * 0.6 : reserve;
    if (cash - sp.houseCost + spare < need) return null;
    return { a, key: tier * 100 + groupRank(sp.group) * 10 + level };
  }).filter((x): x is { a: SpaceAction; key: number } => !!x);
  options.sort((x, y) => x.key - y.key);
  return options[0]?.a ?? null;
}

function unmortgageAction(s: GameState, me: PlayerId, legal: Action[]): Action | null {
  const cash = getPlayer(s, me)!.cash;
  const reserve = cushion(s, me);
  const options = legal
    .filter((a): a is SpaceAction => a.type === 'UNMORTGAGE')
    .map((a) => {
      const sp = propertySpace(a.space)!;
      const inSet = sp.kind === 'street' && ownsFullSet(s, me, sp.group);
      // Freeing a set to build on is worth a thinner cushion than freeing a stray.
      const need = inSet ? reserve : reserve * 1.5 + 100;
      if (cash - unmortgageCost(s, a.space) < need) return null;
      const rank = inSet ? 0 : sp.kind === 'railroad' ? 1 : sp.kind === 'street' ? 2 : 3;
      return { a, rank };
    })
    .filter((x): x is { a: SpaceAction; rank: number } => !!x)
    .sort((x, y) => x.rank - y.rank);
  return options[0]?.a ?? null;
}

function raiseMoney(s: GameState, me: PlayerId, legal: Action[]): Action | null {
  if (legal.some((a) => a.type === 'PAY_DEBT')) return { type: 'PAY_DEBT' };
  if (liquidationValue(s, me) < totalDebt(s, me)) return { type: 'DECLARE_BANKRUPTCY' };

  const mortgageRank = (i: number) => {
    const sp = propertySpace(i)!;
    if (sp.kind !== 'street') return sp.kind === 'utility' ? 0 : 2;
    if (ownsFullSet(s, me, sp.group)) return 4;
    return groupSpaces(sp.group).filter((g) => s.properties[g].ownerId === me).length > 1 ? 3 : 1;
  };
  const mortgages = legal
    .filter((a): a is SpaceAction => a.type === 'MORTGAGE')
    .map((a) => ({ a, rank: mortgageRank(a.space), price: propertySpace(a.space)!.price }))
    .sort((x, y) => x.rank - y.rank || x.price - y.price);
  if (mortgages[0] && mortgages[0].rank <= 3) return mortgages[0].a;

  // Sell the houses above three first, from the weakest sets.
  const sells = legal
    .filter((a): a is SpaceAction => a.type === 'SELL_BUILDING')
    .map((a) => {
      const sp = propertySpace(a.space)!;
      const level = s.properties[a.space].buildings;
      const group = sp.kind === 'street' ? groupRank(sp.group) : 0;
      return { a, key: (level > 3 ? 0 : 100) - group * 10 };
    })
    .sort((x, y) => x.key - y.key);
  if (sells[0]) return sells[0].a;
  if (mortgages[0]) return mortgages[0].a;
  return { type: 'DECLARE_BANKRUPTCY' };
}

// ------------------------------------------------------------------ jail

function stayInJail(s: GameState, me: PlayerId): boolean {
  // Early, every turn in jail is a turn not buying. Late, jail shelters you from developed sets.
  if (unownedCount(s) >= 6) return false;
  return opponentBuildings(s, me) >= 6 || (opponentRents(s, me)[0] ?? 0) >= 400;
}

// ------------------------------------------------------------------ trades

function tradeGains(s: GameState, from: PlayerId, to: PlayerId, give: Assets, get: Assets) {
  const owners = ownersOf(s);
  const after = { ...owners };
  for (const i of give.properties) after[i] = to;
  for (const i of get.properties) after[i] = from;
  const fee = (props: number[]) => props
    .filter((i) => s.properties[i].mortgaged)
    .reduce((n, i) => n + Math.ceil(propertySpace(i)!.mortgage * s.rules.mortgageInterest), 0);
  const side = (pid: PlayerId, cashDelta: number, received: number[]) => {
    const cashAfter = getPlayer(s, pid)!.cash + cashDelta - fee(received);
    const gain = holdingsValue(s, after, pid) - holdingsValue(s, owners, pid) + cashDelta - fee(received);
    // Running yourself dry to make a deal is a cost too.
    const short = Math.max(0, cushion(s, pid) - cashAfter);
    return gain - short * 0.5;
  };
  return {
    from: side(from, get.cash - give.cash, get.properties),
    to: side(to, give.cash - get.cash, give.properties),
  };
}

const acceptable = (mine: number, theirs: number) => mine > 0 && mine >= theirs * 0.85 - 10;

function wouldAccept(s: GameState, t: TradeOffer): boolean {
  const g = tradeGains(s, t.from, t.to, t.give, t.get);
  return acceptable(g.to, g.from);
}

function tradeAction(s: GameState, me: PlayerId, mem: BotMemory): Action | null {
  if (tradesBlocked(s) || s.trades.some((t) => t.from === me) || mem.lastTradeTurn === s.turn.number) return null;
  mem.lastTradeTurn = s.turn.number;
  const owners = ownersOf(s);
  const myCash = getPlayer(s, me)!.cash;
  const tradable = (i: number) => !setHasBuildings(s, i);
  let best: { offer: Omit<TradeOffer, 'id' | 'from'>; gain: number; key: string } | null = null;

  for (const g of GROUPS) {
    const gs = groupSpaces(g);
    const missing = gs.filter((i) => owners[i] !== me);
    const have = gs.length - missing.length;
    if (!have || !missing.length || missing.length > have) continue;
    const holders = new Set(missing.map((i) => owners[i]));
    if (holders.size !== 1 || holders.has(null)) continue;
    const other = [...holders][0]!;
    if (!missing.every(tradable)) continue;
    const otherP = getPlayer(s, other)!;

    // What to put on the table: nothing (cash only), the pieces they need for one of their sets, or one loose property.
    const gives: number[][] = [[]];
    for (const h of GROUPS) {
      if (h === g) continue;
      const hs = groupSpaces(h);
      const myIn = hs.filter((i) => owners[i] === me);
      const theirs = hs.filter((i) => owners[i] === other);
      if (myIn.length && theirs.length && myIn.length + theirs.length === hs.length && myIn.every(tradable)) gives.push(myIn);
    }
    for (const i of ownedProperties(s, me)) {
      const sp = propertySpace(i)!;
      if (sp.kind === 'street' && (sp.group === g || ownsFullSet(s, me, sp.group))) continue;
      if (tradable(i)) gives.push([i]);
    }

    for (const give of gives) {
      const get = missing;
      const g0 = tradeGains(s, me, other, { cash: 0, properties: give, jailCards: [] }, { cash: 0, properties: get, jailCards: [] });
      const d = (g0.from - g0.to) / 2;
      let giveCash = 0;
      let getCash = 0;
      if (d > 0) giveCash = Math.ceil((d + 10) / 10) * 10;
      else if (d < -20) getCash = Math.floor((-d - 10) / 10) * 10;
      if (giveCash > myCash || getCash > otherP.cash) continue;
      const giveA: Assets = { cash: giveCash, properties: give, jailCards: [] };
      const getA: Assets = { cash: getCash, properties: get, jailCards: [] };
      if (whyAssetsInvalid(s, me, giveA) || whyAssetsInvalid(s, other, getA)) continue;
      const gains = tradeGains(s, me, other, giveA, getA);
      if (gains.from < 40 || !acceptable(gains.to, gains.from)) continue;
      const key = `${other}|${[...give].sort()}|${[...get].sort()}|${giveCash}|${getCash}`;
      if (mem.proposed.has(key)) continue;
      if (!best || gains.from > best.gain) best = { offer: { to: other, give: giveA, get: getA }, gain: gains.from, key };
    }
  }
  if (!best) return null;
  mem.proposed.add(best.key);
  return { type: 'PROPOSE_TRADE', offer: best.offer };
}

/** For tests and logs: the strategy's view of who is strongest. */
export function strategicValue(s: GameState, pid: PlayerId): number {
  return holdingsValue(s, ownersOf(s), pid) + (getPlayer(s, pid)?.cash ?? 0);
}
