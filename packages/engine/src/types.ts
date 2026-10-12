// Static definitions (board, cards, ruleset) and the dynamic, JSON-serialisable GameState.

export type ColorGroup =
  | 'brown' | 'lightBlue' | 'pink' | 'orange' | 'red' | 'yellow' | 'green' | 'darkBlue';

export type SpaceDef =
  | { kind: 'go' | 'jail' | 'freeParking' | 'goToJail'; index: number; name: string }
  | {
      kind: 'street'; index: number; name: string; group: ColorGroup; price: number;
      rent: [number, number, number, number, number, number]; // base, 1-4 houses, hotel
      houseCost: number; mortgage: number;
    }
  | { kind: 'railroad' | 'utility'; index: number; name: string; price: number; mortgage: number }
  | { kind: 'tax'; index: number; name: string; amount: number }
  | { kind: 'chance' | 'chest'; index: number; name: string };

export type PropertySpace = Extract<SpaceDef, { kind: 'street' | 'railroad' | 'utility' }>;

export type CardEffect =
  | { type: 'moveTo'; index: number; collectGo: boolean }
  | { type: 'moveBy'; steps: number }
  | { type: 'moveToNearest'; kind: 'railroad' | 'utility' }
  | { type: 'money'; amount: number }        // + from bank, - to bank
  | { type: 'eachPlayer'; amount: number }   // + collect from each, - pay each
  | { type: 'repairs'; perHouse: number; perHotel: number }
  | { type: 'goToJail' }
  | { type: 'getOutOfJailFree' };

export interface CardDef { id: string; deck: 'chance' | 'chest'; text: string; effect: CardEffect }

export interface Ruleset {
  startingCash: number;
  goSalary: number;
  jailFine: number;
  maxJailTurns: number;
  houseSupply: number;
  hotelSupply: number;
  mortgageInterest: number; // 0.1 = 10%
  evenBuild: boolean;
  freeParkingJackpot: boolean;
}

export type PlayerId = string;

export interface Player {
  id: PlayerId;
  name: string;
  token: string;
  color: string;
  cash: number;
  position: number; // 0-39
  inJail: boolean;
  jailTurns: number;
  jailCards: string[]; // card ids
  bankrupt: boolean;
}

export interface PropertyState {
  ownerId: PlayerId | null;
  buildings: number; // 0-4 houses, 5 = hotel
  mortgaged: boolean;
}

export type Phase = 'preRoll' | 'postRoll' | 'gameOver';

export interface Assets { cash: number; properties: number[]; jailCards: string[] }

export interface TradeOffer {
  id: string;
  from: PlayerId;
  to: PlayerId;
  give: Assets; // from -> to
  get: Assets;  // to -> from
}

export type PendingDecision =
  | { type: 'buyOrAuction'; playerId: PlayerId; space: number }
  | {
      type: 'auction'; id: number; space: number; highBid: number;
      highBidder: PlayerId | null; bidders: PlayerId[]; // bidders still in (not passed)
    };

export interface Debt {
  debtorId: PlayerId; creditor: PlayerId | 'bank'; amount: number; reason: string;
  toPot?: boolean; // a bank payment that feeds the Free Parking jackpot
}

export interface GameState {
  schemaVersion: 1;
  rngState: number;
  rules: Ruleset;
  players: Player[];
  turnOrder: PlayerId[];
  properties: Record<number, PropertyState>;
  bank: { houses: number; hotels: number; freeParkingPot: number };
  decks: { chance: string[]; chest: string[] }; // card ids, top first
  turn: {
    playerId: PlayerId;
    phase: Phase;
    doublesCount: number;
    rollAgain: boolean;
    lastRoll: [number, number] | null;
    number: number;
  };
  pending: PendingDecision | null;
  auctionQueue: number[]; // spaces waiting to be auctioned (bankruptcy to the bank)
  nextAuctionId: number;
  debts: Debt[];
  trades: TradeOffer[]; // open offers
  nextTradeId: number;
  winner: PlayerId | null;
  log: string[]; // newest last, capped
}

export interface PlayerSetup { id: PlayerId; name: string; token: string; color: string }

export interface GameSetup { players: PlayerSetup[]; rules?: Partial<Ruleset> }

export type Action =
  | { type: 'ROLL_DICE' }
  | { type: 'END_TURN' }
  | { type: 'BUY' }
  | { type: 'DECLINE_BUY' }
  | { type: 'BID'; amount: number }
  | { type: 'PASS_BID' }
  | { type: 'CLOSE_AUCTION' } // host only
  | { type: 'REMOVE_PLAYER'; playerId: PlayerId } // host only: a player who left; their property goes to the bank
  | { type: 'LEAVE_GAME' }
  | { type: 'BUILD' | 'SELL_BUILDING' | 'MORTGAGE' | 'UNMORTGAGE'; space: number }
  | { type: 'PROPOSE_TRADE'; offer: Omit<TradeOffer, 'id' | 'from'> & { from?: PlayerId } }
  | { type: 'ACCEPT_TRADE' | 'REJECT_TRADE' | 'WITHDRAW_TRADE'; tradeId: string }
  | { type: 'PAY_JAIL_FINE' }
  | { type: 'USE_JAIL_CARD' }
  | { type: 'PAY_DEBT' }
  | { type: 'DECLARE_BANKRUPTCY' };

export interface Envelope { action: Action; by: PlayerId | 'host'; seq: number }

export type GameEvent =
  | { type: 'diceRolled'; playerId: PlayerId; dice: [number, number] }
  | { type: 'moved'; playerId: PlayerId; from: number; to: number; passedGo: boolean }
  | { type: 'paid'; from: PlayerId | 'bank'; to: PlayerId | 'bank'; amount: number; reason: string }
  | { type: 'cardDrawn'; playerId: PlayerId; cardId: string; text: string }
  | { type: 'propertyChanged'; space: number }
  | { type: 'sentToJail' | 'leftJail' | 'bankrupt'; playerId: PlayerId }
  | { type: 'auctionStarted' | 'auctionEnded'; space: number }
  | { type: 'trade'; tradeId: string; status: 'proposed' | 'accepted' | 'rejected' | 'withdrawn' | 'cancelled' }
  | { type: 'gameOver'; winner: PlayerId }
  | { type: 'log'; text: string };

export type ApplyResult = { state: GameState; events: GameEvent[] } | { error: string };
