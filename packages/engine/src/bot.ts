import { random } from './rng';
import { legalActions } from './legal';
import { activePlayers, getPlayer, ownedProperties } from './selectors';
import type { Action, GameState, PlayerId } from './types';

/**
 * Random bot used by the simulation tests (not a real opponent). It leans towards
 * buying, building and paying so games reach a bankruptcy instead of stalling.
 * `rng` is separate from the game's PRNG so bots never change the dice.
 */
export function randomBotAction(s: GameState, me: PlayerId, rng: () => number): Action | null {
  const legal = legalActions(s, me);
  if (!legal.length) return null;
  const pick = <T>(xs: T[]) => xs[Math.floor(rng() * xs.length)];
  const of = (t: Action['type']) => legal.filter((a) => a.type === t);
  const p = getPlayer(s, me)!;

  if (of('PAY_DEBT').length) return of('PAY_DEBT')[0];
  if (of('DECLARE_BANKRUPTCY').length) {
    const raise = legal.filter((a) => a.type === 'MORTGAGE' || a.type === 'SELL_BUILDING');
    if (raise.length) return pick(raise);
    if (rng() < 0.9) return of('DECLARE_BANKRUPTCY')[0];
  }
  const bid = of('BID')[0];
  if (bid && bid.type === 'BID') {
    if (rng() < 0.5) return { type: 'BID', amount: Math.min(p.cash, bid.amount + Math.floor(rng() * 40)) };
    if (of('PASS_BID').length) return of('PASS_BID')[0];
    return null;
  }
  if (of('PASS_BID').length) return of('PASS_BID')[0];
  if (of('BUY').length && rng() < 0.85) return of('BUY')[0];
  if (of('DECLINE_BUY').length) return of('DECLINE_BUY')[0];
  if (rng() < 0.1 && of('ACCEPT_TRADE').length) return pick(of('ACCEPT_TRADE'));
  if (of('REJECT_TRADE').length && rng() < 0.5) return pick(of('REJECT_TRADE'));
  if (of('BUILD').length && rng() < 0.6) return pick(of('BUILD'));
  if (of('UNMORTGAGE').length && rng() < 0.3) return pick(of('UNMORTGAGE'));
  if (rng() < 0.03 && !s.pending) {
    const others = activePlayers(s).filter((x) => x.id !== me);
    const mine = ownedProperties(s, me);
    const other = pick(others);
    if (other) {
      const theirs = ownedProperties(s, other.id);
      return {
        type: 'PROPOSE_TRADE',
        offer: {
          to: other.id,
          give: { cash: Math.floor(rng() * Math.min(p.cash, 200)), properties: mine.length && rng() < 0.5 ? [pick(mine)] : [], jailCards: [] },
          get: { cash: 0, properties: theirs.length ? [pick(theirs)] : [], jailCards: [] },
        },
      };
    }
  }
  const turnish = legal.filter((a) => ['ROLL_DICE', 'END_TURN', 'PAY_JAIL_FINE', 'USE_JAIL_CARD'].includes(a.type));
  if (turnish.length) return pick(turnish);
  return null;
}
