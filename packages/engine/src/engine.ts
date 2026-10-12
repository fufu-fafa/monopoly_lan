import { BOARD, CARD_BY_ID, CARDS, JAIL_INDEX, STANDARD_RULES } from './data/board';
import { rollDie, shuffle } from './rng';
import {
  activePlayers, debtsOf, getPlayer, groupSpaces, playerName, propertySpace, rentFor, space,
  totalDebt, tradesBlocked, unmortgageCost, whyAssetsInvalid, whyCannotBuild, whyCannotMortgage,
  whyCannotSell, whyCannotUnmortgage, type RentOptions,
} from './selectors';
import type {
  Action, ApplyResult, Envelope, GameEvent, GameSetup, GameState, Player, PlayerId, TradeOffer,
} from './types';

const LOG_CAP = 200;

class RuleError extends Error {}

function fail(message: string): never {
  throw new RuleError(message);
}

interface Ctx { s: GameState; events: GameEvent[] }

// ---------------------------------------------------------------- setup

export function createGame(setup: GameSetup, seed: number): GameState {
  if (setup.players.length < 2) throw new Error('Need at least 2 players');
  const rules = { ...STANDARD_RULES, ...setup.rules };
  const properties: GameState['properties'] = {};
  for (const sp of BOARD) {
    if (propertySpace(sp.index)) properties[sp.index] = { ownerId: null, buildings: 0, mortgaged: false };
  }
  const s: GameState = {
    schemaVersion: 1,
    rngState: seed >>> 0,
    rules,
    players: setup.players.map((p) => ({
      ...p, cash: rules.startingCash, position: 0, inJail: false, jailTurns: 0, jailCards: [], bankrupt: false,
    })),
    turnOrder: setup.players.map((p) => p.id),
    properties,
    bank: { houses: rules.houseSupply, hotels: rules.hotelSupply, freeParkingPot: 0 },
    decks: { chance: [], chest: [] },
    turn: { playerId: setup.players[0].id, phase: 'preRoll', doublesCount: 0, rollAgain: false, lastRoll: null, number: 1 },
    pending: null,
    auctionQueue: [],
    nextAuctionId: 1,
    debts: [],
    trades: [],
    nextTradeId: 1,
    winner: null,
    log: [],
  };
  s.decks.chance = shuffle(s, CARDS.filter((c) => c.deck === 'chance').map((c) => c.id));
  s.decks.chest = shuffle(s, CARDS.filter((c) => c.deck === 'chest').map((c) => c.id));
  s.log.push(`Game started. ${s.players[0].name} goes first.`);
  return s;
}

// ---------------------------------------------------------------- helpers

function log(ctx: Ctx, text: string) {
  ctx.s.log.push(text);
  if (ctx.s.log.length > LOG_CAP) ctx.s.log.splice(0, ctx.s.log.length - LOG_CAP);
  ctx.events.push({ type: 'log', text });
}

function mustPlayer(s: GameState, id: PlayerId): Player {
  const p = getPlayer(s, id);
  if (!p) fail('Unknown player');
  return p;
}

const name = (ctx: Ctx, id: PlayerId | 'bank') => playerName(ctx.s, id);

/** Moves cash that is known to be available. `toPot` routes bank payments into the Free Parking pot. */
function transfer(ctx: Ctx, from: PlayerId | 'bank', to: PlayerId | 'bank', amount: number, reason: string, toPot = false) {
  if (amount <= 0) return;
  const { s } = ctx;
  if (from !== 'bank') mustPlayer(s, from).cash -= amount;
  if (to !== 'bank') mustPlayer(s, to).cash += amount;
  else if (toPot && s.rules.freeParkingJackpot) s.bank.freeParkingPot += amount;
  ctx.events.push({ type: 'paid', from, to, amount, reason });
}

/** A payment the player may not be able to cover; a shortfall becomes a debt to settle before play goes on. */
function charge(ctx: Ctx, from: PlayerId, to: PlayerId | 'bank', amount: number, reason: string, toPot = false) {
  if (amount <= 0) return;
  const p = mustPlayer(ctx.s, from);
  if (p.cash >= amount) {
    transfer(ctx, from, to, amount, reason, toPot);
    log(ctx, `${p.name} paid $${amount} to ${name(ctx, to)} (${reason}).`);
  } else {
    ctx.s.debts.push({ debtorId: from, creditor: to, amount, reason, toPot });
    log(ctx, `${p.name} owes $${amount} to ${name(ctx, to)} (${reason}) and must raise funds.`);
  }
}

function setPhaseAfterMove(ctx: Ctx) {
  ctx.s.turn.phase = 'postRoll';
}

// ---------------------------------------------------------------- movement and landing

function moveTo(ctx: Ctx, pid: PlayerId, to: number, collectGo: boolean) {
  const p = mustPlayer(ctx.s, pid);
  const from = p.position;
  const passedGo = collectGo && to < from;
  p.position = to;
  ctx.events.push({ type: 'moved', playerId: pid, from, to, passedGo });
  if (passedGo) {
    transfer(ctx, 'bank', pid, ctx.s.rules.goSalary, 'GO salary');
    log(ctx, `${p.name} passed GO and collected $${ctx.s.rules.goSalary}.`);
  }
}

function moveBy(ctx: Ctx, pid: PlayerId, steps: number) {
  const p = mustPlayer(ctx.s, pid);
  const to = (p.position + steps + 40) % 40;
  if (steps > 0) moveTo(ctx, pid, to, true);
  else moveTo(ctx, pid, to, false);
}

function sendToJail(ctx: Ctx, pid: PlayerId) {
  const p = mustPlayer(ctx.s, pid);
  const from = p.position;
  p.position = JAIL_INDEX;
  p.inJail = true;
  p.jailTurns = 0;
  ctx.events.push({ type: 'moved', playerId: pid, from, to: JAIL_INDEX, passedGo: false });
  ctx.events.push({ type: 'sentToJail', playerId: pid });
  if (ctx.s.turn.playerId === pid) {
    ctx.s.turn.rollAgain = false;
    ctx.s.turn.doublesCount = 0;
  }
  log(ctx, `${p.name} went to jail.`);
}

function leaveJail(ctx: Ctx, pid: PlayerId) {
  const p = mustPlayer(ctx.s, pid);
  p.inJail = false;
  p.jailTurns = 0;
  ctx.events.push({ type: 'leftJail', playerId: pid });
}

function land(ctx: Ctx, pid: PlayerId, opts: RentOptions & { dice: number }) {
  const { s } = ctx;
  const p = mustPlayer(s, pid);
  const sp = space(p.position);
  switch (sp.kind) {
    case 'street':
    case 'railroad':
    case 'utility': {
      const prop = s.properties[sp.index];
      if (!prop.ownerId) {
        s.pending = { type: 'buyOrAuction', playerId: pid, space: sp.index };
        log(ctx, `${p.name} landed on ${sp.name} (unowned, $${sp.price}).`);
      } else if (prop.ownerId === pid) {
        log(ctx, `${p.name} landed on their own ${sp.name}.`);
      } else if (prop.mortgaged) {
        log(ctx, `${p.name} landed on ${sp.name}; it is mortgaged, so no rent.`);
      } else if (mustPlayer(s, prop.ownerId).bankrupt) {
        // cannot happen: bankrupt players own nothing
      } else {
        let rentOpts = opts;
        if (sp.kind === 'utility' && opts.utilityTenX) {
          const d: [number, number] = [rollDie(s), rollDie(s)];
          ctx.events.push({ type: 'diceRolled', playerId: pid, dice: d });
          log(ctx, `${p.name} rolled ${d[0]} + ${d[1]} for the utility.`);
          rentOpts = { ...opts, dice: d[0] + d[1] };
        }
        charge(ctx, pid, prop.ownerId, rentFor(s, sp.index, rentOpts), `rent on ${sp.name}`);
      }
      break;
    }
    case 'tax':
      charge(ctx, pid, 'bank', sp.amount, sp.name, true);
      break;
    case 'chance':
    case 'chest':
      drawCard(ctx, pid, sp.kind, opts.dice);
      break;
    case 'goToJail':
      sendToJail(ctx, pid);
      break;
    case 'freeParking':
      if (s.rules.freeParkingJackpot && s.bank.freeParkingPot > 0) {
        const pot = s.bank.freeParkingPot;
        s.bank.freeParkingPot = 0;
        transfer(ctx, 'bank', pid, pot, 'Free Parking jackpot');
        log(ctx, `${p.name} collected the Free Parking jackpot of $${pot}!`);
      }
      break;
    default:
      break;
  }
}

function drawCard(ctx: Ctx, pid: PlayerId, deck: 'chance' | 'chest', dice: number) {
  const { s } = ctx;
  const p = mustPlayer(s, pid);
  const id = s.decks[deck].shift();
  if (!id) return; // every card of this deck is held as a jail card
  const card = CARD_BY_ID[id];
  if (card.effect.type !== 'getOutOfJailFree') s.decks[deck].push(id);
  ctx.events.push({ type: 'cardDrawn', playerId: pid, cardId: id, text: card.text });
  log(ctx, `${p.name} drew ${deck === 'chance' ? 'Chance' : 'Community Chest'}: "${card.text}"`);
  const e = card.effect;
  switch (e.type) {
    case 'moveTo':
      moveTo(ctx, pid, e.index, e.collectGo);
      land(ctx, pid, { dice });
      break;
    case 'moveBy':
      moveBy(ctx, pid, e.steps);
      land(ctx, pid, { dice });
      break;
    case 'moveToNearest': {
      let i = p.position;
      do i = (i + 1) % 40; while (space(i).kind !== e.kind);
      moveTo(ctx, pid, i, true);
      land(ctx, pid, e.kind === 'railroad' ? { dice, railroadMultiplier: 2 } : { dice, utilityTenX: true });
      break;
    }
    case 'money':
      if (e.amount > 0) transfer(ctx, 'bank', pid, e.amount, card.text);
      else charge(ctx, pid, 'bank', -e.amount, 'card', true);
      break;
    case 'eachPlayer':
      for (const other of activePlayers(s)) {
        if (other.id === pid) continue;
        if (e.amount > 0) charge(ctx, other.id, pid, e.amount, 'card');
        else charge(ctx, pid, other.id, -e.amount, 'card');
      }
      break;
    case 'repairs': {
      let houses = 0, hotels = 0;
      for (const [i, prop] of Object.entries(s.properties)) {
        if (prop.ownerId !== pid || space(Number(i)).kind !== 'street') continue;
        if (prop.buildings === 5) hotels++;
        else houses += prop.buildings;
      }
      charge(ctx, pid, 'bank', houses * e.perHouse + hotels * e.perHotel, 'repairs', true);
      break;
    }
    case 'goToJail':
      sendToJail(ctx, pid);
      break;
    case 'getOutOfJailFree':
      p.jailCards.push(id);
      break;
  }
}

// ---------------------------------------------------------------- turn flow

function nextActivePlayer(s: GameState, after: PlayerId): PlayerId {
  const order = s.turnOrder;
  let i = order.indexOf(after);
  for (let n = 0; n < order.length; n++) {
    i = (i + 1) % order.length;
    if (!mustPlayerRaw(s, order[i]).bankrupt) return order[i];
  }
  return after;
}

function mustPlayerRaw(s: GameState, id: PlayerId) {
  return s.players.find((p) => p.id === id)!;
}

function advanceTurn(ctx: Ctx) {
  const { s } = ctx;
  const next = nextActivePlayer(s, s.turn.playerId);
  s.turn = { playerId: next, phase: 'preRoll', doublesCount: 0, rollAgain: false, lastRoll: null, number: s.turn.number + 1 };
  log(ctx, `It is ${name(ctx, next)}'s turn.`);
}

function rollDice(ctx: Ctx, pid: PlayerId) {
  const { s } = ctx;
  const p = mustPlayer(s, pid);
  const d: [number, number] = [rollDie(s), rollDie(s)];
  const total = d[0] + d[1];
  const doubles = d[0] === d[1];
  s.turn.lastRoll = d;
  ctx.events.push({ type: 'diceRolled', playerId: pid, dice: d });
  log(ctx, `${p.name} rolled ${d[0]} + ${d[1]}${doubles ? ' (doubles)' : ''}.`);
  s.turn.rollAgain = false;

  if (p.inJail) {
    setPhaseAfterMove(ctx);
    if (doubles) {
      leaveJail(ctx, pid);
      log(ctx, `${p.name} rolled doubles and left jail.`);
    } else {
      p.jailTurns++;
      if (p.jailTurns < s.rules.maxJailTurns) {
        log(ctx, `${p.name} stays in jail.`);
        return;
      }
      leaveJail(ctx, pid);
      charge(ctx, pid, 'bank', s.rules.jailFine, 'jail fine', true);
    }
    moveBy(ctx, pid, total);
    land(ctx, pid, { dice: total });
    return;
  }

  if (doubles) {
    s.turn.doublesCount++;
    if (s.turn.doublesCount >= 3) {
      log(ctx, `${p.name} rolled doubles three times.`);
      setPhaseAfterMove(ctx);
      sendToJail(ctx, pid);
      return;
    }
  }
  setPhaseAfterMove(ctx);
  s.turn.rollAgain = doubles;
  moveBy(ctx, pid, total);
  land(ctx, pid, { dice: total });
}

// ---------------------------------------------------------------- auctions

function startAuction(ctx: Ctx, index: number) {
  const { s } = ctx;
  const bidders = activePlayers(s).filter((p) => p.cash > 0 && debtsOf(s, p.id).length === 0).map((p) => p.id);
  ctx.events.push({ type: 'auctionStarted', space: index });
  if (bidders.length === 0) {
    log(ctx, `Nobody can bid on ${space(index).name}; it stays with the bank.`);
    return;
  }
  s.pending = { type: 'auction', id: s.nextAuctionId++, space: index, highBid: 0, highBidder: null, bidders };
  log(ctx, `${space(index).name} is up for auction.`);
}

function closeAuction(ctx: Ctx) {
  const { s } = ctx;
  const a = s.pending;
  if (a?.type !== 'auction') fail('No auction is open');
  s.pending = null;
  const sp = space(a.space);
  if (a.highBidder) {
    transfer(ctx, a.highBidder, 'bank', a.highBid, `won ${sp.name} at auction`);
    s.properties[a.space] = { ownerId: a.highBidder, buildings: 0, mortgaged: false };
    ctx.events.push({ type: 'propertyChanged', space: a.space });
    log(ctx, `${name(ctx, a.highBidder)} won ${sp.name} for $${a.highBid}.`);
  } else {
    log(ctx, `No bids for ${sp.name}; it stays with the bank.`);
  }
  ctx.events.push({ type: 'auctionEnded', space: a.space });
  startQueuedAuction(ctx);
}

function startQueuedAuction(ctx: Ctx) {
  const { s } = ctx;
  while (!s.pending && s.auctionQueue.length && !s.winner) {
    startAuction(ctx, s.auctionQueue.shift()!);
  }
}

function maybeAutoClose(ctx: Ctx) {
  const a = ctx.s.pending;
  if (a?.type !== 'auction') return;
  if (a.bidders.length === 0 || (a.bidders.length === 1 && a.bidders[0] === a.highBidder)) closeAuction(ctx);
}

// ---------------------------------------------------------------- debt and bankruptcy

function payDebts(ctx: Ctx, pid: PlayerId) {
  const { s } = ctx;
  const p = mustPlayer(s, pid);
  const total = totalDebt(s, pid);
  if (total === 0) fail('You have no debts');
  if (p.cash < total) fail(`You need $${total - p.cash} more`);
  for (const d of debtsOf(s, pid)) {
    transfer(ctx, pid, d.creditor, d.amount, d.reason, d.toPot);
    log(ctx, `${p.name} paid $${d.amount} to ${name(ctx, d.creditor)} (${d.reason}).`);
  }
  s.debts = s.debts.filter((d) => d.debtorId !== pid);
}

/** Takes a player out of the game. `quit` is for a player who left or was removed: everything goes to the bank. */
function declareBankruptcy(ctx: Ctx, pid: PlayerId, quit = false) {
  const { s } = ctx;
  const p = mustPlayer(s, pid);
  const owed = debtsOf(s, pid);
  if (!owed.length && !quit) fail('You can only go bankrupt while you owe money');
  const playerCreditor = quit ? undefined
    : owed.find((d) => d.creditor !== 'bank' && !mustPlayer(s, d.creditor).bankrupt)?.creditor as PlayerId | undefined;
  const creditor: PlayerId | 'bank' = playerCreditor ?? 'bank';
  s.debts = s.debts.filter((d) => d.debtorId !== pid && d.creditor !== pid);

  // Buildings go back to the bank at half cost.
  for (const [key, prop] of Object.entries(s.properties)) {
    const i = Number(key);
    if (prop.ownerId !== pid || prop.buildings === 0) continue;
    const sp = space(i);
    if (sp.kind !== 'street') continue;
    if (prop.buildings === 5) s.bank.hotels++;
    else s.bank.houses += prop.buildings;
    transfer(ctx, 'bank', pid, (prop.buildings * sp.houseCost) / 2, 'buildings sold');
    prop.buildings = 0;
  }
  p.cash = Math.floor(p.cash);

  if (creditor !== 'bank') {
    transfer(ctx, pid, creditor, p.cash, 'bankruptcy');
    let fee = 0;
    for (const [key, prop] of Object.entries(s.properties)) {
      if (prop.ownerId !== pid) continue;
      prop.ownerId = creditor;
      if (prop.mortgaged) fee += Math.ceil(propertySpace(Number(key))!.mortgage * s.rules.mortgageInterest);
      ctx.events.push({ type: 'propertyChanged', space: Number(key) });
    }
    mustPlayer(s, creditor).jailCards.push(...p.jailCards);
    // Like a trade, taking over mortgaged property costs the 10% interest.
    if (fee > 0) charge(ctx, creditor, 'bank', fee, 'mortgage fee on inherited property');
  } else {
    if (p.cash > 0) transfer(ctx, pid, 'bank', p.cash, 'bankruptcy');
    for (const [key, prop] of Object.entries(s.properties)) {
      if (prop.ownerId !== pid) continue;
      s.properties[Number(key)] = { ownerId: null, buildings: 0, mortgaged: false };
      s.auctionQueue.push(Number(key));
      ctx.events.push({ type: 'propertyChanged', space: Number(key) });
    }
    for (const c of p.jailCards) s.decks[CARD_BY_ID[c].deck].push(c);
  }
  p.jailCards = [];
  p.cash = 0;
  p.bankrupt = true;
  p.inJail = false;
  s.trades = s.trades.filter((t) => {
    if (t.from !== pid && t.to !== pid) return true;
    ctx.events.push({ type: 'trade', tradeId: t.id, status: 'cancelled' });
    return false;
  });
  if (s.pending?.type === 'auction') {
    s.pending.bidders = s.pending.bidders.filter((b) => b !== pid);
  }
  if (s.pending?.type === 'buyOrAuction' && s.pending.playerId === pid) {
    s.auctionQueue.unshift(s.pending.space);
    s.pending = null;
  }
  ctx.events.push({ type: 'bankrupt', playerId: pid });
  log(ctx, quit ? `${p.name} left the game; their property goes back to the bank.` : `${p.name} is bankrupt; their assets go to ${name(ctx, creditor)}.`);

  const left = activePlayers(s);
  if (left.length === 1) {
    s.winner = left[0].id;
    s.turn.phase = 'gameOver';
    s.pending = null;
    s.auctionQueue = [];
    s.debts = [];
    s.trades = [];
    ctx.events.push({ type: 'gameOver', winner: left[0].id });
    log(ctx, `${left[0].name} wins the game!`);
    return;
  }
  if (s.turn.playerId === pid) advanceTurn(ctx);
  maybeAutoClose(ctx);
  startQueuedAuction(ctx);
}

// ---------------------------------------------------------------- trades

function proposeTrade(ctx: Ctx, by: PlayerId, offer: Extract<Action, { type: 'PROPOSE_TRADE' }>['offer']) {
  const { s } = ctx;
  const blocked = tradesBlocked(s);
  if (blocked) fail(blocked);
  const to = getPlayer(s, offer.to);
  if (!to || to.bankrupt || to.id === by) fail('Pick another player to trade with');
  const give = normaliseAssets(offer.give);
  const get = normaliseAssets(offer.get);
  if (!give.cash && !give.properties.length && !give.jailCards.length && !get.cash && !get.properties.length && !get.jailCards.length)
    fail('The trade is empty');
  const bad = whyAssetsInvalid(s, by, give) ?? whyAssetsInvalid(s, to.id, get);
  if (bad) fail(bad);
  const trade: TradeOffer = { id: `t${s.nextTradeId++}`, from: by, to: to.id, give, get };
  s.trades.push(trade);
  ctx.events.push({ type: 'trade', tradeId: trade.id, status: 'proposed' });
  log(ctx, `${name(ctx, by)} offered a trade to ${to.name}.`);
}

function normaliseAssets(a: unknown) {
  const x = (a ?? {}) as Partial<{ cash: unknown; properties: unknown; jailCards: unknown }>;
  return {
    cash: typeof x.cash === 'number' ? x.cash : 0,
    properties: Array.isArray(x.properties) ? x.properties.map(Number) : [],
    jailCards: Array.isArray(x.jailCards) ? x.jailCards.map(String) : [],
  };
}

function findTrade(s: GameState, id: string) {
  const t = s.trades.find((x) => x.id === id);
  if (!t) fail('That trade is no longer open');
  return t;
}

function acceptTrade(ctx: Ctx, by: PlayerId, tradeId: string) {
  const { s } = ctx;
  const blocked = tradesBlocked(s);
  if (blocked) fail(blocked);
  const t = findTrade(s, tradeId);
  if (t.to !== by) fail('This trade is not addressed to you');
  const bad = whyAssetsInvalid(s, t.from, t.give) ?? whyAssetsInvalid(s, t.to, t.get);
  if (bad) fail(bad);
  s.trades = s.trades.filter((x) => x.id !== t.id);
  const move = (from: PlayerId, to: PlayerId, a: TradeOffer['give']) => {
    transfer(ctx, from, to, a.cash, 'trade');
    for (const i of a.properties) {
      s.properties[i].ownerId = to;
      ctx.events.push({ type: 'propertyChanged', space: i });
    }
    const fromP = mustPlayer(s, from);
    fromP.jailCards = fromP.jailCards.filter((c) => !a.jailCards.includes(c));
    mustPlayer(s, to).jailCards.push(...a.jailCards);
  };
  move(t.from, t.to, t.give);
  move(t.to, t.from, t.get);
  ctx.events.push({ type: 'trade', tradeId: t.id, status: 'accepted' });
  log(ctx, `${name(ctx, t.to)} accepted ${name(ctx, t.from)}'s trade.`);
  // Receiving mortgaged property costs the interest fee.
  for (const [receiver, a] of [[t.to, t.give], [t.from, t.get]] as const) {
    const fee = a.properties
      .filter((i) => s.properties[i].mortgaged)
      .reduce((n, i) => n + Math.ceil(propertySpace(i)!.mortgage * s.rules.mortgageInterest), 0);
    if (fee > 0) charge(ctx, receiver, 'bank', fee, 'mortgage fee on traded property');
  }
}

function cancelInvalidTrades(ctx: Ctx) {
  const { s } = ctx;
  s.trades = s.trades.filter((t) => {
    const bad = whyAssetsInvalid(s, t.from, t.give) ?? whyAssetsInvalid(s, t.to, t.get);
    if (!bad) return true;
    ctx.events.push({ type: 'trade', tradeId: t.id, status: 'cancelled' });
    log(ctx, `${name(ctx, t.from)}'s trade with ${name(ctx, t.to)} was cancelled (${bad}).`);
    return false;
  });
}

// ---------------------------------------------------------------- applyAction

export function applyAction(state: GameState, env: Envelope): ApplyResult {
  const s: GameState = JSON.parse(JSON.stringify(state));
  const ctx: Ctx = { s, events: [] };
  try {
    dispatch(ctx, env);
    cancelInvalidTrades(ctx);
    return { state: s, events: ctx.events };
  } catch (e) {
    if (e instanceof RuleError) return { error: e.message };
    throw e;
  }
}

function requireTurn(s: GameState, by: PlayerId) {
  if (s.turn.playerId !== by) fail("It is not your turn");
  if (s.pending) fail(s.pending.type === 'auction' ? 'Wait for the auction to finish' : 'Decide whether to buy first');
}

function requireNoDebts(s: GameState) {
  if (s.debts.length) {
    const names = [...new Set(s.debts.map((d) => playerName(s, d.debtorId)))].join(', ');
    fail(`Waiting for ${names} to settle debts`);
  }
}

function dispatch(ctx: Ctx, env: Envelope) {
  const { s } = ctx;
  const a = env.action;
  if (!a || typeof a !== 'object') fail('Bad action');
  if (s.winner) fail('The game is over');

  if (a.type === 'CLOSE_AUCTION') {
    if (env.by !== 'host') fail('Only the host closes auctions');
    closeAuction(ctx);
    return;
  }
  if (a.type === 'REMOVE_PLAYER') {
    if (env.by !== 'host') fail('Only the host removes players');
    if (s.pending?.type === 'auction') fail('Wait for the auction to finish');
    const target = getPlayer(s, a.playerId);
    if (!target || target.bankrupt) fail('That player is not in the game');
    declareBankruptcy(ctx, a.playerId, true);
    return;
  }
  if (env.by === 'host') fail('The host can only close auctions');
  const by = env.by;
  const me = mustPlayer(s, by);
  if (me.bankrupt) fail('You are out of the game');

  switch (a.type) {
    case 'ROLL_DICE': {
      requireTurn(s, by);
      requireNoDebts(s);
      if (!(s.turn.phase === 'preRoll' || (s.turn.phase === 'postRoll' && s.turn.rollAgain))) fail('You cannot roll now');
      rollDice(ctx, by);
      return;
    }
    case 'END_TURN': {
      requireTurn(s, by);
      requireNoDebts(s);
      if (s.turn.phase !== 'postRoll') fail('Roll first');
      if (s.turn.rollAgain) fail('You rolled doubles; roll again');
      advanceTurn(ctx);
      return;
    }
    case 'PAY_JAIL_FINE': {
      requireTurn(s, by);
      if (s.turn.phase !== 'preRoll' || !me.inJail) fail('You are not in jail');
      if (me.cash < s.rules.jailFine) fail(`You need $${s.rules.jailFine}`);
      transfer(ctx, by, 'bank', s.rules.jailFine, 'jail fine', true);
      leaveJail(ctx, by);
      log(ctx, `${me.name} paid $${s.rules.jailFine} to leave jail.`);
      return;
    }
    case 'USE_JAIL_CARD': {
      requireTurn(s, by);
      if (s.turn.phase !== 'preRoll' || !me.inJail) fail('You are not in jail');
      const card = me.jailCards.shift();
      if (!card) fail('You have no Get Out of Jail Free card');
      s.decks[CARD_BY_ID[card].deck].push(card);
      leaveJail(ctx, by);
      log(ctx, `${me.name} used a Get Out of Jail Free card.`);
      return;
    }
    case 'BUY': {
      const p = s.pending;
      if (p?.type !== 'buyOrAuction' || p.playerId !== by) fail('Nothing to buy');
      const sp = propertySpace(p.space)!;
      if (debtsOf(s, by).length) fail('Pay your debts first');
      if (me.cash < sp.price) fail(`You need $${sp.price}`);
      transfer(ctx, by, 'bank', sp.price, `bought ${sp.name}`);
      s.properties[p.space].ownerId = by;
      s.pending = null;
      ctx.events.push({ type: 'propertyChanged', space: p.space });
      log(ctx, `${me.name} bought ${sp.name} for $${sp.price}.`);
      return;
    }
    case 'DECLINE_BUY': {
      const p = s.pending;
      if (p?.type !== 'buyOrAuction' || p.playerId !== by) fail('Nothing to decline');
      s.pending = null;
      log(ctx, `${me.name} declined to buy ${space(p.space).name}.`);
      startAuction(ctx, p.space);
      return;
    }
    case 'BID': {
      const p = s.pending;
      if (p?.type !== 'auction') fail('No auction is open');
      if (!p.bidders.includes(by)) fail('You are out of this auction');
      const amount = Number(a.amount);
      if (!Number.isInteger(amount) || amount <= p.highBid) fail(`Bid more than $${p.highBid}`);
      if (amount > me.cash) fail(`You only have $${me.cash}`);
      p.highBid = amount;
      p.highBidder = by;
      log(ctx, `${me.name} bid $${amount}.`);
      maybeAutoClose(ctx);
      return;
    }
    case 'PASS_BID': {
      const p = s.pending;
      if (p?.type !== 'auction') fail('No auction is open');
      if (!p.bidders.includes(by)) fail('You are already out');
      if (p.highBidder === by) fail('You hold the high bid');
      p.bidders = p.bidders.filter((b) => b !== by);
      log(ctx, `${me.name} passed.`);
      maybeAutoClose(ctx);
      return;
    }
    case 'BUILD': {
      const why = whyCannotBuild(s, by, a.space);
      if (why) fail(why);
      const sp = space(a.space) as Extract<ReturnType<typeof space>, { kind: 'street' }>;
      const prop = s.properties[a.space];
      transfer(ctx, by, 'bank', sp.houseCost, `building on ${sp.name}`);
      if (prop.buildings === 4) { s.bank.houses += 4; s.bank.hotels--; } else s.bank.houses--;
      prop.buildings++;
      ctx.events.push({ type: 'propertyChanged', space: a.space });
      log(ctx, `${me.name} built a ${prop.buildings === 5 ? 'hotel' : 'house'} on ${sp.name}.`);
      return;
    }
    case 'SELL_BUILDING': {
      const why = whyCannotSell(s, by, a.space);
      if (why) fail(why);
      const sp = space(a.space) as Extract<ReturnType<typeof space>, { kind: 'street' }>;
      const prop = s.properties[a.space];
      if (prop.buildings === 5) { s.bank.hotels++; s.bank.houses -= 4; } else s.bank.houses++;
      const wasHotel = prop.buildings === 5;
      prop.buildings--;
      transfer(ctx, 'bank', by, sp.houseCost / 2, `sold a building on ${sp.name}`);
      ctx.events.push({ type: 'propertyChanged', space: a.space });
      log(ctx, `${me.name} sold a ${wasHotel ? 'hotel' : 'house'} on ${sp.name} for $${sp.houseCost / 2}.`);
      return;
    }
    case 'MORTGAGE': {
      const why = whyCannotMortgage(s, by, a.space);
      if (why) fail(why);
      const sp = propertySpace(a.space)!;
      s.properties[a.space].mortgaged = true;
      transfer(ctx, 'bank', by, sp.mortgage, `mortgaged ${sp.name}`);
      ctx.events.push({ type: 'propertyChanged', space: a.space });
      log(ctx, `${me.name} mortgaged ${sp.name} for $${sp.mortgage}.`);
      return;
    }
    case 'UNMORTGAGE': {
      const why = whyCannotUnmortgage(s, by, a.space);
      if (why) fail(why);
      const sp = propertySpace(a.space)!;
      const cost = unmortgageCost(s, a.space);
      s.properties[a.space].mortgaged = false;
      transfer(ctx, by, 'bank', cost, `unmortgaged ${sp.name}`);
      ctx.events.push({ type: 'propertyChanged', space: a.space });
      log(ctx, `${me.name} lifted the mortgage on ${sp.name} for $${cost}.`);
      return;
    }
    case 'PROPOSE_TRADE':
      proposeTrade(ctx, by, a.offer);
      return;
    case 'ACCEPT_TRADE':
      acceptTrade(ctx, by, a.tradeId);
      return;
    case 'REJECT_TRADE': {
      const t = findTrade(s, a.tradeId);
      if (t.to !== by) fail('This trade is not addressed to you');
      s.trades = s.trades.filter((x) => x.id !== t.id);
      ctx.events.push({ type: 'trade', tradeId: t.id, status: 'rejected' });
      log(ctx, `${me.name} rejected ${name(ctx, t.from)}'s trade.`);
      return;
    }
    case 'WITHDRAW_TRADE': {
      const t = findTrade(s, a.tradeId);
      if (t.from !== by) fail('You did not propose this trade');
      s.trades = s.trades.filter((x) => x.id !== t.id);
      ctx.events.push({ type: 'trade', tradeId: t.id, status: 'withdrawn' });
      log(ctx, `${me.name} withdrew their trade offer.`);
      return;
    }
    case 'PAY_DEBT':
      if (s.pending?.type === 'auction') fail('Wait for the auction to finish');
      payDebts(ctx, by);
      return;
    case 'DECLARE_BANKRUPTCY':
      if (s.pending?.type === 'auction') fail('Wait for the auction to finish');
      declareBankruptcy(ctx, by);
      return;
    case 'LEAVE_GAME':
      if (s.pending?.type === 'auction') fail('Wait for the auction to finish');
      declareBankruptcy(ctx, by, true);
      return;
    default:
      fail('Unknown action');
  }
}

