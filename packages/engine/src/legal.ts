import {
  debtsOf, getPlayer, ownedProperties, propertySpace, totalDebt, whyAssetsInvalid, whyCannotBuild,
  whyCannotMortgage, whyCannotSell, whyCannotUnmortgage,
} from './selectors';
import type { Action, GameState, PlayerId } from './types';

/** Who the game is waiting on right now (for the turn banner). */
export function waitingOn(s: GameState): PlayerId[] {
  if (s.winner) return [];
  if (s.pending?.type === 'auction') return s.pending.bidders;
  if (s.pending?.type === 'buyOrAuction') return [s.pending.playerId];
  if (s.debts.length) return [...new Set(s.debts.map((d) => d.debtorId))];
  return [s.turn.playerId];
}

/**
 * The actions `playerId` may take now. BID carries the minimum legal amount; the
 * server re-validates everything through applyAction, so this only drives the UI.
 */
export function legalActions(s: GameState, playerId: PlayerId): Action[] {
  const me = getPlayer(s, playerId);
  if (!me || me.bankrupt || s.winner) return [];
  const out: Action[] = [];
  const p = s.pending;

  if (p?.type === 'auction') {
    if (p.bidders.includes(playerId)) {
      if (me.cash > p.highBid) out.push({ type: 'BID', amount: p.highBid + 1 });
      if (p.highBidder !== playerId) out.push({ type: 'PASS_BID' });
    }
    return out;
  }

  const myDebts = debtsOf(s, playerId);
  if (myDebts.length) {
    if (me.cash >= totalDebt(s, playerId)) out.push({ type: 'PAY_DEBT' });
    out.push({ type: 'DECLARE_BANKRUPTCY' });
  }

  if (p?.type === 'buyOrAuction' && p.playerId === playerId) {
    if (!myDebts.length && me.cash >= propertySpace(p.space)!.price) out.push({ type: 'BUY' });
    out.push({ type: 'DECLINE_BUY' });
  }

  if (!p && s.turn.playerId === playerId) {
    const t = s.turn;
    if (t.phase === 'preRoll' && me.inJail) {
      if (me.cash >= s.rules.jailFine) out.push({ type: 'PAY_JAIL_FINE' });
      if (me.jailCards.length) out.push({ type: 'USE_JAIL_CARD' });
    }
    if (!s.debts.length) {
      if (t.phase === 'preRoll' || (t.phase === 'postRoll' && t.rollAgain)) out.push({ type: 'ROLL_DICE' });
      else if (t.phase === 'postRoll') out.push({ type: 'END_TURN' });
    }
  }

  for (const i of ownedProperties(s, playerId)) {
    if (!whyCannotBuild(s, playerId, i)) out.push({ type: 'BUILD', space: i });
    if (!whyCannotSell(s, playerId, i)) out.push({ type: 'SELL_BUILDING', space: i });
    if (!whyCannotMortgage(s, playerId, i)) out.push({ type: 'MORTGAGE', space: i });
    if (!whyCannotUnmortgage(s, playerId, i)) out.push({ type: 'UNMORTGAGE', space: i });
  }

  out.push({ type: 'LEAVE_GAME' });

  for (const t of s.trades) {
    if (t.to === playerId) {
      if (!whyAssetsInvalid(s, t.from, t.give) && !whyAssetsInvalid(s, t.to, t.get))
        out.push({ type: 'ACCEPT_TRADE', tradeId: t.id });
      out.push({ type: 'REJECT_TRADE', tradeId: t.id });
    }
    if (t.from === playerId) out.push({ type: 'WITHDRAW_TRADE', tradeId: t.id });
  }
  return out;
}
