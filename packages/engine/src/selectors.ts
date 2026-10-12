import { BOARD, RAILROAD_RENT, UTILITY_MULTIPLIER } from './data/board';
import type { Assets, ColorGroup, GameState, Player, PlayerId, PropertySpace, SpaceDef } from './types';

export function space(index: number): SpaceDef {
  return BOARD[index];
}

export function isProperty(sp: SpaceDef): sp is PropertySpace {
  return sp.kind === 'street' || sp.kind === 'railroad' || sp.kind === 'utility';
}

export function propertySpace(index: number): PropertySpace | null {
  const sp = BOARD[index];
  return sp && isProperty(sp) ? sp : null;
}

export function getPlayer(s: GameState, id: PlayerId): Player | undefined {
  return s.players.find((p) => p.id === id);
}

export function playerName(s: GameState, id: PlayerId | 'bank'): string {
  return id === 'bank' ? 'the bank' : getPlayer(s, id)?.name ?? id;
}

export function activePlayers(s: GameState): Player[] {
  return s.players.filter((p) => !p.bankrupt);
}

export function groupSpaces(group: ColorGroup): number[] {
  return BOARD.filter((sp) => sp.kind === 'street' && sp.group === group).map((sp) => sp.index);
}

export function ownsFullSet(s: GameState, owner: PlayerId, group: ColorGroup): boolean {
  return groupSpaces(group).every((i) => s.properties[i].ownerId === owner);
}

/** Spaces whose buildings must be zero before `index` can be mortgaged or traded. */
export function setOf(index: number): number[] {
  const sp = BOARD[index];
  return sp.kind === 'street' ? groupSpaces(sp.group) : [index];
}

export function setHasBuildings(s: GameState, index: number): boolean {
  return setOf(index).some((i) => s.properties[i].buildings > 0);
}

export function ownedProperties(s: GameState, owner: PlayerId): number[] {
  return Object.keys(s.properties).map(Number).filter((i) => s.properties[i].ownerId === owner);
}

export function debtsOf(s: GameState, id: PlayerId) {
  return s.debts.filter((d) => d.debtorId === id);
}

export function totalDebt(s: GameState, id: PlayerId): number {
  return debtsOf(s, id).reduce((n, d) => n + d.amount, 0);
}

export function unmortgageCost(s: GameState, index: number): number {
  const sp = propertySpace(index)!;
  return Math.ceil(sp.mortgage * (1 + s.rules.mortgageInterest));
}

export interface RentOptions { dice?: number; railroadMultiplier?: number; utilityTenX?: boolean }

export function rentFor(s: GameState, index: number, opts: RentOptions = {}): number {
  const sp = propertySpace(index);
  const prop = s.properties[index];
  if (!sp || !prop || !prop.ownerId || prop.mortgaged) return 0;
  const owner = prop.ownerId;
  if (sp.kind === 'street') {
    if (prop.buildings > 0) return sp.rent[prop.buildings];
    return ownsFullSet(s, owner, sp.group) ? sp.rent[0] * 2 : sp.rent[0];
  }
  if (sp.kind === 'railroad') {
    const n = BOARD.filter((x) => x.kind === 'railroad' && s.properties[x.index].ownerId === owner).length;
    return RAILROAD_RENT[n - 1] * (opts.railroadMultiplier ?? 1);
  }
  const n = BOARD.filter((x) => x.kind === 'utility' && s.properties[x.index].ownerId === owner).length;
  const mult = opts.utilityTenX ? 10 : UTILITY_MULTIPLIER[n - 1];
  return mult * (opts.dice ?? 7);
}

export function netWorth(s: GameState, id: PlayerId): number {
  const p = getPlayer(s, id);
  if (!p || p.bankrupt) return 0;
  let total = p.cash;
  for (const i of ownedProperties(s, id)) {
    const sp = propertySpace(i)!;
    const prop = s.properties[i];
    total += prop.mortgaged ? sp.price - sp.mortgage : sp.price;
    if (sp.kind === 'street') total += prop.buildings * sp.houseCost;
  }
  return total;
}

// ---- Management checks: each returns null when allowed, otherwise the reason. ----

function managementBlocked(s: GameState, id: PlayerId): string | null {
  const p = getPlayer(s, id);
  if (!p || p.bankrupt) return 'You are not in the game';
  if (s.winner) return 'The game is over';
  if (s.pending?.type === 'auction') return 'Wait for the auction to finish';
  return null;
}

export function whyCannotBuild(s: GameState, id: PlayerId, index: number): string | null {
  const blocked = managementBlocked(s, id);
  if (blocked) return blocked;
  const sp = propertySpace(index);
  if (!sp || sp.kind !== 'street') return 'Only streets can have houses';
  const prop = s.properties[index];
  if (prop.ownerId !== id) return 'You do not own this street';
  if (!ownsFullSet(s, id, sp.group)) return 'You need the full colour set';
  const group = groupSpaces(sp.group);
  if (group.some((i) => s.properties[i].mortgaged)) return 'A street in this set is mortgaged';
  if (prop.buildings >= 5) return 'Already has a hotel';
  if (s.rules.evenBuild && prop.buildings > Math.min(...group.map((i) => s.properties[i].buildings)))
    return 'Build evenly across the set';
  if (prop.buildings === 4 ? s.bank.hotels < 1 : s.bank.houses < 1)
    return prop.buildings === 4 ? 'The bank has no hotels left' : 'The bank has no houses left';
  if (debtsOf(s, id).length) return 'Pay your debts first';
  const p = getPlayer(s, id)!;
  if (p.cash < sp.houseCost) return `You need $${sp.houseCost}`;
  return null;
}

export function whyCannotSell(s: GameState, id: PlayerId, index: number): string | null {
  const blocked = managementBlocked(s, id);
  if (blocked) return blocked;
  const sp = propertySpace(index);
  if (!sp || sp.kind !== 'street') return 'Only streets have buildings';
  const prop = s.properties[index];
  if (prop.ownerId !== id) return 'You do not own this street';
  if (prop.buildings === 0) return 'No buildings to sell';
  const group = groupSpaces(sp.group);
  if (s.rules.evenBuild && prop.buildings < Math.max(...group.map((i) => s.properties[i].buildings)))
    return 'Sell evenly across the set';
  if (prop.buildings === 5 && s.bank.houses < 4) return 'The bank needs 4 houses to break up a hotel';
  return null;
}

export function whyCannotMortgage(s: GameState, id: PlayerId, index: number): string | null {
  const blocked = managementBlocked(s, id);
  if (blocked) return blocked;
  const sp = propertySpace(index);
  if (!sp) return 'Not a property';
  const prop = s.properties[index];
  if (prop.ownerId !== id) return 'You do not own this property';
  if (prop.mortgaged) return 'Already mortgaged';
  if (setHasBuildings(s, index)) return 'Sell the buildings in this set first';
  return null;
}

export function whyCannotUnmortgage(s: GameState, id: PlayerId, index: number): string | null {
  const blocked = managementBlocked(s, id);
  if (blocked) return blocked;
  const sp = propertySpace(index);
  if (!sp) return 'Not a property';
  const prop = s.properties[index];
  if (prop.ownerId !== id) return 'You do not own this property';
  if (!prop.mortgaged) return 'Not mortgaged';
  if (debtsOf(s, id).length) return 'Pay your debts first';
  const cost = unmortgageCost(s, index);
  if (getPlayer(s, id)!.cash < cost) return `You need $${cost}`;
  return null;
}

// ---- Trades ----

export function emptyAssets(): Assets {
  return { cash: 0, properties: [], jailCards: [] };
}

export function whyAssetsInvalid(s: GameState, owner: PlayerId, a: Assets): string | null {
  const p = getPlayer(s, owner);
  if (!p || p.bankrupt) return 'Player is not in the game';
  if (!Number.isInteger(a.cash) || a.cash < 0) return 'Cash must be a whole number';
  if (a.cash > p.cash) return `${p.name} does not have $${a.cash}`;
  if (a.cash > 0 && debtsOf(s, owner).length) return `${p.name} must pay debts before giving cash`;
  if (new Set(a.properties).size !== a.properties.length) return 'Duplicate property';
  for (const i of a.properties) {
    if (!propertySpace(i)) return 'Not a property';
    if (s.properties[i].ownerId !== owner) return `${p.name} does not own ${space(i).name}`;
    if (setHasBuildings(s, i)) return `Sell the buildings in ${space(i).name}'s set first`;
  }
  for (const c of a.jailCards) if (!p.jailCards.includes(c)) return `${p.name} does not hold that card`;
  return null;
}

export function tradesBlocked(s: GameState): string | null {
  if (s.winner) return 'The game is over';
  if (s.pending?.type === 'auction') return 'No trading during an auction';
  return null;
}
