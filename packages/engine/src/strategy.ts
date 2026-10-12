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
 * - keep a cash cushion sized to the worst rent on the board;
 * - when one player controls most of the board, everyone else goes all in against them,
 *   and no bot makes a trade that would hand its partner control of the board.
 * Each call returns one action (or null when there is nothing to do); the caller loops.
 *
 * When a leader controls the board, advanced bots also work together against them (see `allies`):
 * they pick the strongest of them as a champion and pour everything into it (cash, property, jail
 * cards; buildings are sold first so their sets can move), leave auctions to it, trade with each
 * other for the alliance's gain, and buy a property off an ally who would otherwise go bankrupt to the leader.
 *
 * A basic bot (`advanced: false`) plays the same, except that it ignores who controls the board:
 * it never goes all in against a leader, does not refuse trades over board control, and joins no alliance.
 */

export interface BotMemory {
  advanced: boolean;
  allies: PlayerId[]; // the other advanced bots, who team up when someone else controls the board
  proposed: Set<string>; // trades already offered, so a bot never repeats itself
  lastTradeTurn: number;
  tradeSeen: Map<string, number>; // own open offers -> turn first seen
}

export function newBotMemory(opts: { advanced?: boolean; allies?: PlayerId[] } = {}): BotMemory {
  return { advanced: opts.advanced ?? true, allies: opts.allies ?? [], proposed: new Set(), lastTradeTurn: -1, tradeSeen: new Map() };
}

// The level of the bot whose move is being worked out. strategyBotAction sets it for the length of
// one synchronous call, so every valuation below sees the same level without threading it through.
let advanced = true;
let allies: PlayerId[] = [];

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

/**
 * How much a street is worth relative to its price, by progress towards its set. A missing piece the
 * bank still holds can be landed on or won at auction; one held by an opponent needs a trade.
 */
function setMultiplier(owners: Owners, pid: PlayerId, g: ColorGroup): number {
  const group = groupSpaces(g);
  const n = group.filter((i) => owners[i] === pid).length;
  if (n === group.length) return SET_WEIGHT[g];
  const missing = group.filter((i) => owners[i] !== pid);
  const unowned = missing.filter((i) => owners[i] == null).length;
  const holders = new Set(missing.map((i) => owners[i]).filter((o) => o != null)).size;
  const extra = SET_WEIGHT[g] - 1;
  // Each held piece is progress; it counts for more the fewer opponents stand in the way.
  const progress = (n / group.length) * (unowned === missing.length ? 0.45 : holders === 1 ? 0.3 : 0.15);
  return 1 + extra * progress * (n >= 2 || group.length === 2 ? 1 : 0.5);
}

/** What a player's property is worth to them under a (possibly hypothetical) ownership map. */
function holdingsValue(s: GameState, owners: Owners, pid: PlayerId, countMortgages = true): number {
  let v = 0;
  let rails = 0;
  let utils = 0;
  for (const [k, owner] of Object.entries(owners)) {
    if (owner !== pid) continue;
    const i = Number(k);
    const sp = propertySpace(i)!;
    const prop = s.properties[i];
    if (prop.mortgaged && countMortgages) v -= Math.ceil(sp.mortgage * (1 + s.rules.mortgageInterest));
    if (sp.kind !== 'street') {
      if (sp.kind === 'railroad') rails++;
      else utils++;
      continue;
    }
    v += sp.price * setMultiplier(owners, pid, sp.group) + prop.buildings * sp.houseCost;
  }
  return v + RAIL_VALUE[rails] + UTIL_VALUE[utils];
}

// ------------------------------------------------------------------ board control

/**
 * A player controls the board when they own at least 10 of the 28 deeds and more than half the
 * value of all owned property (sets, houses and railroads count for more than their price).
 */
function controlsBoard(s: GameState, owners: Owners, pid: PlayerId): boolean {
  if (Object.values(owners).filter((o) => o === pid).length < 10) return false;
  let mine = 0;
  let total = 0;
  for (const p of activePlayers(s)) {
    // Mortgages are ignored so that raising cash never flips who leads.
    const v = holdingsValue(s, owners, p.id, false);
    total += v;
    if (p.id === pid) mine = v;
  }
  return mine > total * 0.5;
}

/** The player who controls most of the board right now, if any. */
const leaderCache = new WeakMap<GameState, PlayerId | null>();
export function boardLeader(s: GameState): PlayerId | null {
  // A state is never changed once applyAction returns it, so the answer can be kept per state.
  if (leaderCache.has(s)) return leaderCache.get(s)!;
  const owners = ownersOf(s);
  const leader = activePlayers(s).find((p) => controlsBoard(s, owners, p.id))?.id ?? null;
  leaderCache.set(s, leader);
  return leader;
}

/** Someone else controls the board: stop playing safe, spend everything and gang up on them. */
function allIn(s: GameState, me: PlayerId): boolean {
  if (!advanced) return false;
  const leader = boardLeader(s);
  return !!leader && leader !== me;
}

/** `pid` is an advanced bot on my side against a board leader that neither of us is. */
function isAlly(s: GameState, me: PlayerId, pid: PlayerId): boolean {
  if (!allies.includes(pid) || getPlayer(s, pid)?.bankrupt !== false) return false;
  const leader = boardLeader(s);
  return !!leader && leader !== me && leader !== pid;
}

/**
 * The alliance's champion: its strongest member, by property value plus cash. Every ally works it
 * out from the same state, so they all agree without talking.
 */
function champion(s: GameState, me: PlayerId): PlayerId | null {
  const leader = boardLeader(s);
  if (!advanced || !leader || leader === me) return null;
  const team = [me, ...allies.filter((a) => isAlly(s, me, a))];
  if (team.length < 2) return null;
  return team.sort((a, b) => strategicValue(s, b) - strategicValue(s, a) || a.localeCompare(b))[0];
}

/** Value to `pid` of gaining property `i`, plus what it denies the opponent who wants it most (all of it against a board leader). */
function propertyWorth(s: GameState, pid: PlayerId, i: number): { mine: number; block: number } {
  const leader = advanced ? boardLeader(s) : null;
  const owners = ownersOf(s);
  const without = { ...owners, [i]: null };
  const mine = holdingsValue(s, { ...without, [i]: pid }, pid) - holdingsValue(s, without, pid);
  const price = propertySpace(i)!.price;
  let block = 0;
  for (const o of activePlayers(s)) {
    if (o.id === pid) continue;
    const theirs = holdingsValue(s, { ...without, [i]: o.id }, o.id) - holdingsValue(s, without, o.id);
    block = Math.max(block, (theirs - price) * (o.id === leader ? 1 : 0.5));
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
  if (allIn(s, me)) return 0;
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
  advanced = mem.advanced;
  allies = mem.advanced ? mem.allies : [];
  try {
    return decide(s, me, mem);
  } finally {
    advanced = true;
    allies = [];
  }
}

function decide(s: GameState, me: PlayerId, mem: BotMemory): Action | null {
  const p = getPlayer(s, me);
  if (!p || p.bankrupt || s.winner) return null;
  const legal = legalActions(s, me);
  const has = (t: Action['type']) => legal.some((a) => a.type === t);

  if (s.pending?.type === 'auction') return auctionAction(s, me, legal);

  // Answer offers first: an ally's rescue can arrive while I am in debt.
  for (const t of s.trades) {
    if (t.to !== me) continue;
    const accept = legal.some((a) => a.type === 'ACCEPT_TRADE' && a.tradeId === t.id) && wouldAccept(s, t);
    return { type: accept ? 'ACCEPT_TRADE' : 'REJECT_TRADE', tradeId: t.id };
  }

  if (debtsOf(s, me).length) {
    const rescue = rescueRequest(s, me, mem);
    return rescue === 'wait' ? null : rescue ?? raiseMoney(s, me, legal);
  }

  if (s.pending?.type === 'buyOrAuction' && s.pending.playerId === me) {
    return has('BUY') && shouldBuy(s, me, s.pending.space) ? { type: 'BUY' } : { type: 'DECLINE_BUY' };
  }

  if (!s.pending) {
    const dump = dumpToChampion(s, me, legal);
    if (dump) return dump;
  }

  if (s.pending || s.turn.playerId !== me) return null;

  // Own turn: tidy up offers nobody answered, then manage, trade, and roll.
  for (const t of s.trades) {
    if (t.from !== me) continue;
    if (!mem.tradeSeen.has(t.id)) mem.tradeSeen.set(t.id, s.turn.number);
    if (s.turn.number - mem.tradeSeen.get(t.id)! >= activePlayers(s).length) return { type: 'WITHDRAW_TRADE', tradeId: t.id };
  }

  const manage = unmortgageAction(s, me, legal) ?? buildAction(s, me, legal) ?? fundBuildingAction(s, me, legal);
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
  // Supporters leave auctions to the champion, who now holds the alliance's cash.
  const champ = champion(s, me);
  if (champ && champ !== me && a.bidders.includes(champ)) return legal.some((x) => x.type === 'PASS_BID') ? { type: 'PASS_BID' } : null;
  // Let an ally have it cheaply rather than bid them up; the leader is the one to outbid.
  if (a.highBidder && isAlly(s, me, a.highBidder)) return legal.some((x) => x.type === 'PASS_BID') ? { type: 'PASS_BID' } : null;
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
  // All in, the highest rent matters more than starving anyone of houses.
  const opponentSet = !allIn(s, me) && activePlayers(s).some((o) => o.id !== me && GROUPS.some((g) => ownsFullSet(s, o.id, g)));

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
  const goingAllIn = allIn(s, me);
  const options = legal
    .filter((a): a is SpaceAction => a.type === 'UNMORTGAGE')
    .map((a) => {
      const sp = propertySpace(a.space)!;
      const inSet = sp.kind === 'street' && ownsFullSet(s, me, sp.group);
      if (goingAllIn && !inSet) return null; // that cash goes into houses instead
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

/** All in: mortgage loose property to pay for houses on a set that could take more. */
function fundBuildingAction(s: GameState, me: PlayerId, legal: Action[]): Action | null {
  if (!allIn(s, me) || s.bank.houses < 1 || debtsOf(s, me).length) return null;
  const cash = getPlayer(s, me)!.cash;
  const wantsHouse = ownedProperties(s, me).some((i) => {
    const sp = propertySpace(i)!;
    if (sp.kind !== 'street' || !ownsFullSet(s, me, sp.group) || sp.houseCost <= cash) return false;
    const group = groupSpaces(sp.group);
    return group.every((g) => !s.properties[g].mortgaged) && s.properties[i].buildings < 4;
  });
  if (!wantsHouse) return null;
  const rank = (i: number) => {
    const sp = propertySpace(i)!;
    if (sp.kind !== 'street') return sp.kind === 'utility' ? 0 : 2;
    return ownsFullSet(s, me, sp.group) ? 9 : 1;
  };
  const loose = legal
    .filter((a): a is SpaceAction => a.type === 'MORTGAGE' && rank(a.space) < 9)
    .sort((x, y) => rank(x.space) - rank(y.space));
  return loose[0] ?? null;
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

/** A Get Out of Jail Free card saves the fine and a turn early on; once staying in jail is good it is worth little. */
function jailCardValue(s: GameState, pid: PlayerId): number {
  const p = getPlayer(s, pid)!;
  let v = stayInJail(s, pid) ? 15 : unownedCount(s) >= 6 ? 60 : 40;
  if (p.inJail && !stayInJail(s, pid)) v += 30;
  if (p.cash < cushion(s, pid)) v *= 0.6; // a luxury when you cannot cover a bad landing
  // Each extra card is worth less than the first.
  return p.jailCards.length ? Math.round(v * 0.6) : v;
}

function tradeGains(s: GameState, from: PlayerId, to: PlayerId, give: Assets, get: Assets) {
  const owners = ownersOf(s);
  const after = { ...owners };
  for (const i of give.properties) after[i] = to;
  for (const i of get.properties) after[i] = from;
  const fee = (props: number[]) => props
    .filter((i) => s.properties[i].mortgaged)
    .reduce((n, i) => n + Math.ceil(propertySpace(i)!.mortgage * s.rules.mortgageInterest), 0);
  const side = (pid: PlayerId, cashDelta: number, received: number[], cardsIn: number, cardsOut: number) => {
    const cashAfter = getPlayer(s, pid)!.cash + cashDelta - fee(received);
    const cards = (cardsIn - cardsOut) * jailCardValue(s, pid);
    const gain = holdingsValue(s, after, pid) - holdingsValue(s, owners, pid) + cashDelta - fee(received) + cards;
    // Running yourself dry to make a deal is a cost too.
    const short = Math.max(0, cushion(s, pid) - cashAfter);
    return gain - short * 0.5;
  };
  return {
    from: side(from, get.cash - give.cash, get.properties, get.jailCards.length, give.jailCards.length),
    to: side(to, give.cash - get.cash, give.properties, give.jailCards.length, get.jailCards.length),
  };
}

/** Whether `me` takes a trade with `partner` that gains `mine` and gives the partner `theirs`. */
function acceptable(s: GameState, me: PlayerId, partner: PlayerId, give: Assets, get: Assets, mine: number, theirs: number): boolean {
  const ally = isAlly(s, me, partner);
  if (mine <= 0 && !ally) return false;
  const after = ownersOf(s);
  for (const i of give.properties) after[i] = partner;
  for (const i of get.properties) after[i] = me;
  if (!advanced) return mine >= theirs * 0.85 - 10;
  const leader = boardLeader(s);
  if (leader === partner) {
    // Trading with the leader only to break their hold, or for a set of my own worth at least what they get.
    if (!controlsBoard(s, after, partner)) return mine >= theirs * 0.85 - 10;
    const completesSet = get.properties.some((i) => {
      const sp = propertySpace(i)!;
      return sp.kind === 'street' && groupSpaces(sp.group).every((g) => after[g] === me);
    });
    return completesSet && mine >= theirs;
  }
  // Never hand anyone control of most of the board.
  if (controlsBoard(s, after, partner)) return false;
  // Allies judge a deal by what it does for the alliance, and will give up a little to make it.
  if (ally) return mine + theirs > 0 && mine >= -Math.max(50, theirs * 0.3);
  // Against a leader, any deal that helps another challenger is worth making.
  if (leader && leader !== me) return true;
  return mine >= theirs * 0.85 - 10;
}

function wouldAccept(s: GameState, t: TradeOffer): boolean {
  // An ally handing over everything to their champion.
  const gift = !t.get.cash && !t.get.properties.length && !t.get.jailCards.length;
  if (gift && isAlly(s, t.to, t.from)) return true;
  if (isRescue(s, t, t.to)) {
    // Keeping an ally's property out of the leader's hands is worth paying over the odds for.
    const g = tradeGains(s, t.from, t.to, t.give, t.get);
    return g.to >= -300;
  }
  const g = tradeGains(s, t.from, t.to, t.give, t.get);
  return acceptable(s, t.to, t.from, t.get, t.give, g.to, g.from);
}

interface Deal { other: PlayerId; giveProps: number[]; getProps: number[]; giveCards: string[]; getCards: string[]; min: number }

function tradeAction(s: GameState, me: PlayerId, mem: BotMemory): Action | null {
  if (tradesBlocked(s) || s.trades.some((t) => t.from === me) || mem.lastTradeTurn === s.turn.number) return null;
  mem.lastTradeTurn = s.turn.number;
  const owners = ownersOf(s);
  const meP = getPlayer(s, me)!;
  const tradable = (i: number) => !setHasBuildings(s, i);
  const deals: Deal[] = [];

  for (const g of GROUPS) {
    const gs = groupSpaces(g);
    const have = gs.filter((i) => owners[i] === me).length;
    if (!have || have === gs.length) continue;
    // Ask one opponent at a time for their pieces of the set. This also works when the set is split
    // among several players or some pieces are still with the bank: each deal is a step towards it.
    for (const other of new Set(gs.map((i) => owners[i]).filter((o): o is PlayerId => !!o && o !== me))) {
      const get = gs.filter((i) => owners[i] === other);
      if (!get.every(tradable)) continue;
      const theirCards = getPlayer(s, other)!.jailCards;
      // What to put on the table: cash only, the pieces they need for one of their sets, or one loose property.
      const gives: number[][] = [[]];
      for (const h of GROUPS) {
        if (h === g) continue;
        const hs = groupSpaces(h);
        const myIn = hs.filter((i) => owners[i] === me);
        const theirs = hs.filter((i) => owners[i] === other);
        if (myIn.length && theirs.length && myIn.every(tradable)) gives.push(myIn);
      }
      for (const i of ownedProperties(s, me)) {
        const sp = propertySpace(i)!;
        if (sp.kind === 'street' && (sp.group === g || ownsFullSet(s, me, sp.group))) continue;
        if (tradable(i)) gives.push([i]);
      }
      for (const give of gives) {
        const min = have + get.length === gs.length ? 40 : 25; // a step towards a set is worth doing for less
        deals.push({ other, giveProps: give, getProps: get, giveCards: [], getCards: [], min });
        // Jail cards as sweeteners either way.
        if (meP.jailCards.length) deals.push({ other, giveProps: give, getProps: get, giveCards: [meP.jailCards[0]], getCards: [], min });
        if (theirCards.length) deals.push({ other, giveProps: give, getProps: get, giveCards: [], getCards: [theirCards[0]], min });
      }
    }
  }

  // Jail cards on their own: sell one when cash is short, buy one when it would get you out early.
  for (const o of activePlayers(s)) {
    if (o.id === me) continue;
    if (meP.jailCards.length) deals.push({ other: o.id, giveProps: [], getProps: [], giveCards: [meP.jailCards[0]], getCards: [], min: 5 });
    if (o.jailCards.length) deals.push({ other: o.id, giveProps: [], getProps: [], giveCards: [], getCards: [o.jailCards[0]], min: 5 });
  }

  let best: { offer: Omit<TradeOffer, 'id' | 'from'>; gain: number; key: string } | null = null;
  for (const d of deals) {
    const otherP = getPlayer(s, d.other)!;
    const assets = (cash: number, properties: number[], jailCards: string[]): Assets => ({ cash, properties, jailCards });
    const g0 = tradeGains(s, me, d.other, assets(0, d.giveProps, d.giveCards), assets(0, d.getProps, d.getCards));
    // Balance with cash so both sides gain about the same.
    const diff = (g0.from - g0.to) / 2;
    const step = d.getProps.length || d.giveProps.length ? 10 : 5;
    let giveCash = 0;
    let getCash = 0;
    if (diff > 0) giveCash = Math.ceil((diff + step) / step) * step;
    else if (diff < -2 * step) getCash = Math.floor((-diff - step) / step) * step;
    if (giveCash > meP.cash || getCash > otherP.cash) continue;
    const giveA = assets(giveCash, d.giveProps, d.giveCards);
    const getA = assets(getCash, d.getProps, d.getCards);
    if (whyAssetsInvalid(s, me, giveA) || whyAssetsInvalid(s, d.other, getA)) continue;
    const gains = tradeGains(s, me, d.other, giveA, getA);
    const ally = isAlly(s, me, d.other);
    if ((ally ? gains.from + gains.to : gains.from) < d.min) continue;
    // Only offers both sides would take: I check mine, and judge theirs by the same rules.
    if (!acceptable(s, me, d.other, giveA, getA, gains.from, gains.to)) continue;
    if (!acceptable(s, d.other, me, getA, giveA, gains.to, gains.from)) continue;
    const key = `${d.other}|${[...d.giveProps].sort()}|${[...d.getProps].sort()}|${d.giveCards.length}|${d.getCards.length}|${giveCash}|${getCash}`;
    if (mem.proposed.has(key)) continue;
    const score = ally ? gains.from + gains.to : gains.from;
    if (!best || score > best.gain) best = { offer: { to: d.other, give: giveA, get: getA }, gain: score, key };
  }
  if (!best) return null;
  mem.proposed.add(best.key);
  return { type: 'PROPOSE_TRADE', offer: best.offer };
}

// ------------------------------------------------------------------ alliance champion

/**
 * A supporter gives the champion everything it has. Buildings cannot change hands, so it sells them
 * back to the bank first (at half price) to free its sets. It keeps nothing back: a supporter who
 * then goes bankrupt to the leader hands the leader almost nothing.
 */
function dumpToChampion(s: GameState, me: PlayerId, legal: Action[]): Action | null {
  const champ = champion(s, me);
  if (!champ || champ === me || debtsOf(s, me).length || tradesBlocked(s)) return null;
  if (s.trades.some((t) => t.from === me && t.to === champ)) return null; // waiting for it to accept
  const sell = legal
    .filter((a): a is SpaceAction => a.type === 'SELL_BUILDING')
    .sort((x, y) => s.properties[y.space].buildings - s.properties[x.space].buildings)[0];
  if (sell) return sell;
  const p = getPlayer(s, me)!;
  const give: Assets = {
    cash: p.cash,
    properties: ownedProperties(s, me).filter((i) => !setHasBuildings(s, i)),
    jailCards: [...p.jailCards],
  };
  if (!give.cash && !give.properties.length && !give.jailCards.length) return null;
  if (whyAssetsInvalid(s, me, give)) return null;
  return { type: 'PROPOSE_TRADE', offer: { to: champ, give, get: { cash: 0, properties: [], jailCards: [] } } };
}

// ------------------------------------------------------------------ alliance rescue

/** Debts owed to the board leader, which the leader would collect in full (with everything else) on bankruptcy. */
function owesLeader(s: GameState, pid: PlayerId): boolean {
  const leader = boardLeader(s);
  return !!leader && debtsOf(s, pid).some((d) => d.creditor === leader);
}

/** An offer between allies from one in debt to the leader: a property for just the cash they are short. */
function isRescue(s: GameState, t: TradeOffer, me: PlayerId): boolean {
  const partner = t.from === me ? t.to : t.from;
  return isAlly(s, me, partner) && owesLeader(s, t.from) && t.get.cash > 0 && !t.give.cash
    && t.give.properties.length === 1 && !t.get.properties.length;
}

/**
 * About to go bankrupt to the leader: before handing them everything, sell one property to an ally
 * for exactly the cash still missing after mortgaging the rest. Asked once per ally per debt.
 */
function rescueRequest(s: GameState, me: PlayerId, mem: BotMemory): Action | 'wait' | null {
  if (!owesLeader(s, me) || tradesBlocked(s)) return null;
  if (s.trades.some((t) => t.from === me && isRescue(s, t, me))) return 'wait'; // the ally answers next
  const debt = totalDebt(s, me);
  const liquid = liquidationValue(s, me);
  if (liquid >= debt) return null; // can pay without help
  for (const ally of allies) {
    if (!isAlly(s, me, ally) || debtsOf(s, ally).length) continue;
    const allyCash = getPlayer(s, ally)!.cash;
    const options = ownedProperties(s, me)
      .filter((i) => !setHasBuildings(s, i))
      .map((i) => {
        const sp = propertySpace(i)!;
        const lost = s.properties[i].mortgaged ? 0 : sp.mortgage;
        return { i, cash: Math.ceil((debt - (liquid - lost)) / 10) * 10 };
      })
      .filter((o) => o.cash > 0 && o.cash <= allyCash)
      .sort((x, y) => x.cash - y.cash);
    for (const o of options) {
      const key = `rescue|${ally}|${s.turn.number}|${debt}|${o.i}`;
      if (mem.proposed.has(key)) continue;
      mem.proposed.add(key);
      return { type: 'PROPOSE_TRADE', offer: { to: ally, give: { cash: 0, properties: [o.i], jailCards: [] }, get: { cash: o.cash, properties: [], jailCards: [] } } };
    }
  }
  return null;
}

/** For tests and logs: the strategy's view of who is strongest. */
export function strategicValue(s: GameState, pid: PlayerId): number {
  return holdingsValue(s, ownersOf(s), pid) + (getPlayer(s, pid)?.cash ?? 0);
}
