import type { CardDef, ColorGroup, Ruleset, SpaceDef } from '../types';

// Standard US board. Names belong to Hasbro; fine for a private home game (see PLAN.md, milestone 8).
export const BOARD: SpaceDef[] = [
  { kind: 'go', index: 0, name: 'GO' },
  { kind: 'street', index: 1, name: 'Mediterranean Avenue', group: 'brown', price: 60, rent: [2, 10, 30, 90, 160, 250], houseCost: 50, mortgage: 30 },
  { kind: 'chest', index: 2, name: 'Community Chest' },
  { kind: 'street', index: 3, name: 'Baltic Avenue', group: 'brown', price: 60, rent: [4, 20, 60, 180, 320, 450], houseCost: 50, mortgage: 30 },
  { kind: 'tax', index: 4, name: 'Income Tax', amount: 200 },
  { kind: 'railroad', index: 5, name: 'Reading Railroad', price: 200, mortgage: 100 },
  { kind: 'street', index: 6, name: 'Oriental Avenue', group: 'lightBlue', price: 100, rent: [6, 30, 90, 270, 400, 550], houseCost: 50, mortgage: 50 },
  { kind: 'chance', index: 7, name: 'Chance' },
  { kind: 'street', index: 8, name: 'Vermont Avenue', group: 'lightBlue', price: 100, rent: [6, 30, 90, 270, 400, 550], houseCost: 50, mortgage: 50 },
  { kind: 'street', index: 9, name: 'Connecticut Avenue', group: 'lightBlue', price: 120, rent: [8, 40, 100, 300, 450, 600], houseCost: 50, mortgage: 60 },
  { kind: 'jail', index: 10, name: 'Jail / Just Visiting' },
  { kind: 'street', index: 11, name: 'St. Charles Place', group: 'pink', price: 140, rent: [10, 50, 150, 450, 625, 750], houseCost: 100, mortgage: 70 },
  { kind: 'utility', index: 12, name: 'Electric Company', price: 150, mortgage: 75 },
  { kind: 'street', index: 13, name: 'States Avenue', group: 'pink', price: 140, rent: [10, 50, 150, 450, 625, 750], houseCost: 100, mortgage: 70 },
  { kind: 'street', index: 14, name: 'Virginia Avenue', group: 'pink', price: 160, rent: [12, 60, 180, 500, 700, 900], houseCost: 100, mortgage: 80 },
  { kind: 'railroad', index: 15, name: 'Pennsylvania Railroad', price: 200, mortgage: 100 },
  { kind: 'street', index: 16, name: 'St. James Place', group: 'orange', price: 180, rent: [14, 70, 200, 550, 750, 950], houseCost: 100, mortgage: 90 },
  { kind: 'chest', index: 17, name: 'Community Chest' },
  { kind: 'street', index: 18, name: 'Tennessee Avenue', group: 'orange', price: 180, rent: [14, 70, 200, 550, 750, 950], houseCost: 100, mortgage: 90 },
  { kind: 'street', index: 19, name: 'New York Avenue', group: 'orange', price: 200, rent: [16, 80, 220, 600, 800, 1000], houseCost: 100, mortgage: 100 },
  { kind: 'freeParking', index: 20, name: 'Free Parking' },
  { kind: 'street', index: 21, name: 'Kentucky Avenue', group: 'red', price: 220, rent: [18, 90, 250, 700, 875, 1050], houseCost: 150, mortgage: 110 },
  { kind: 'chance', index: 22, name: 'Chance' },
  { kind: 'street', index: 23, name: 'Indiana Avenue', group: 'red', price: 220, rent: [18, 90, 250, 700, 875, 1050], houseCost: 150, mortgage: 110 },
  { kind: 'street', index: 24, name: 'Illinois Avenue', group: 'red', price: 240, rent: [20, 100, 300, 750, 925, 1100], houseCost: 150, mortgage: 120 },
  { kind: 'railroad', index: 25, name: 'B. & O. Railroad', price: 200, mortgage: 100 },
  { kind: 'street', index: 26, name: 'Atlantic Avenue', group: 'yellow', price: 260, rent: [22, 110, 330, 800, 975, 1150], houseCost: 150, mortgage: 130 },
  { kind: 'street', index: 27, name: 'Ventnor Avenue', group: 'yellow', price: 260, rent: [22, 110, 330, 800, 975, 1150], houseCost: 150, mortgage: 130 },
  { kind: 'utility', index: 28, name: 'Water Works', price: 150, mortgage: 75 },
  { kind: 'street', index: 29, name: 'Marvin Gardens', group: 'yellow', price: 280, rent: [24, 120, 360, 850, 1025, 1200], houseCost: 150, mortgage: 140 },
  { kind: 'goToJail', index: 30, name: 'Go To Jail' },
  { kind: 'street', index: 31, name: 'Pacific Avenue', group: 'green', price: 300, rent: [26, 130, 390, 900, 1100, 1275], houseCost: 200, mortgage: 150 },
  { kind: 'street', index: 32, name: 'North Carolina Avenue', group: 'green', price: 300, rent: [26, 130, 390, 900, 1100, 1275], houseCost: 200, mortgage: 150 },
  { kind: 'chest', index: 33, name: 'Community Chest' },
  { kind: 'street', index: 34, name: 'Pennsylvania Avenue', group: 'green', price: 320, rent: [28, 150, 450, 1000, 1200, 1400], houseCost: 200, mortgage: 160 },
  { kind: 'railroad', index: 35, name: 'Short Line', price: 200, mortgage: 100 },
  { kind: 'chance', index: 36, name: 'Chance' },
  { kind: 'street', index: 37, name: 'Park Place', group: 'darkBlue', price: 350, rent: [35, 175, 500, 1100, 1300, 1500], houseCost: 200, mortgage: 175 },
  { kind: 'tax', index: 38, name: 'Luxury Tax', amount: 100 },
  { kind: 'street', index: 39, name: 'Boardwalk', group: 'darkBlue', price: 400, rent: [50, 200, 600, 1400, 1700, 2000], houseCost: 200, mortgage: 200 },
];

export const JAIL_INDEX = 10;

export const GROUP_COLORS: Record<ColorGroup, string> = {
  brown: '#8b4f2c', lightBlue: '#aee0f5', pink: '#d63c9a', orange: '#f39321',
  red: '#e2231a', yellow: '#fef200', green: '#1fb25a', darkBlue: '#0072bb',
};

export const RAILROAD_RENT = [25, 50, 100, 200];
export const UTILITY_MULTIPLIER = [4, 10];

export const STANDARD_RULES: Ruleset = {
  startingCash: 1500,
  goSalary: 200,
  jailFine: 50,
  maxJailTurns: 3,
  houseSupply: 32,
  hotelSupply: 12,
  mortgageInterest: 0.1,
  evenBuild: true,
  freeParkingJackpot: false,
};

export const CARDS: CardDef[] = [
  // Chance
  { id: 'ch-boardwalk', deck: 'chance', text: 'Advance to Boardwalk.', effect: { type: 'moveTo', index: 39, collectGo: true } },
  { id: 'ch-go', deck: 'chance', text: 'Advance to GO. Collect $200.', effect: { type: 'moveTo', index: 0, collectGo: true } },
  { id: 'ch-illinois', deck: 'chance', text: 'Advance to Illinois Avenue. If you pass GO, collect $200.', effect: { type: 'moveTo', index: 24, collectGo: true } },
  { id: 'ch-stcharles', deck: 'chance', text: 'Advance to St. Charles Place. If you pass GO, collect $200.', effect: { type: 'moveTo', index: 11, collectGo: true } },
  { id: 'ch-rail-1', deck: 'chance', text: 'Advance to the nearest Railroad. If owned, pay the owner twice the rental.', effect: { type: 'moveToNearest', kind: 'railroad' } },
  { id: 'ch-rail-2', deck: 'chance', text: 'Advance to the nearest Railroad. If owned, pay the owner twice the rental.', effect: { type: 'moveToNearest', kind: 'railroad' } },
  { id: 'ch-utility', deck: 'chance', text: 'Advance to the nearest Utility. If owned, roll the dice and pay the owner 10 times the amount.', effect: { type: 'moveToNearest', kind: 'utility' } },
  { id: 'ch-dividend', deck: 'chance', text: 'Bank pays you a dividend of $50.', effect: { type: 'money', amount: 50 } },
  { id: 'ch-jailfree', deck: 'chance', text: 'Get Out of Jail Free. Keep this card until needed.', effect: { type: 'getOutOfJailFree' } },
  { id: 'ch-back3', deck: 'chance', text: 'Go back 3 spaces.', effect: { type: 'moveBy', steps: -3 } },
  { id: 'ch-jail', deck: 'chance', text: 'Go to Jail. Do not pass GO, do not collect $200.', effect: { type: 'goToJail' } },
  { id: 'ch-repairs', deck: 'chance', text: 'Make general repairs on all your property: $25 per house, $100 per hotel.', effect: { type: 'repairs', perHouse: 25, perHotel: 100 } },
  { id: 'ch-speeding', deck: 'chance', text: 'Speeding fine $15.', effect: { type: 'money', amount: -15 } },
  { id: 'ch-reading', deck: 'chance', text: 'Take a trip to Reading Railroad. If you pass GO, collect $200.', effect: { type: 'moveTo', index: 5, collectGo: true } },
  { id: 'ch-chairman', deck: 'chance', text: 'You have been elected Chairman of the Board. Pay each player $50.', effect: { type: 'eachPlayer', amount: -50 } },
  { id: 'ch-loan', deck: 'chance', text: 'Your building loan matures. Collect $150.', effect: { type: 'money', amount: 150 } },
  // Community Chest
  { id: 'cc-go', deck: 'chest', text: 'Advance to GO. Collect $200.', effect: { type: 'moveTo', index: 0, collectGo: true } },
  { id: 'cc-bankerror', deck: 'chest', text: 'Bank error in your favour. Collect $200.', effect: { type: 'money', amount: 200 } },
  { id: 'cc-doctor', deck: 'chest', text: "Doctor's fee. Pay $50.", effect: { type: 'money', amount: -50 } },
  { id: 'cc-stock', deck: 'chest', text: 'From sale of stock you get $50.', effect: { type: 'money', amount: 50 } },
  { id: 'cc-jailfree', deck: 'chest', text: 'Get Out of Jail Free. Keep this card until needed.', effect: { type: 'getOutOfJailFree' } },
  { id: 'cc-jail', deck: 'chest', text: 'Go to Jail. Do not pass GO, do not collect $200.', effect: { type: 'goToJail' } },
  { id: 'cc-holiday', deck: 'chest', text: 'Holiday fund matures. Receive $100.', effect: { type: 'money', amount: 100 } },
  { id: 'cc-taxrefund', deck: 'chest', text: 'Income tax refund. Collect $20.', effect: { type: 'money', amount: 20 } },
  { id: 'cc-birthday', deck: 'chest', text: 'It is your birthday. Collect $10 from every player.', effect: { type: 'eachPlayer', amount: 10 } },
  { id: 'cc-life', deck: 'chest', text: 'Life insurance matures. Collect $100.', effect: { type: 'money', amount: 100 } },
  { id: 'cc-hospital', deck: 'chest', text: 'Pay hospital fees of $100.', effect: { type: 'money', amount: -100 } },
  { id: 'cc-school', deck: 'chest', text: 'Pay school fees of $50.', effect: { type: 'money', amount: -50 } },
  { id: 'cc-consult', deck: 'chest', text: 'Receive $25 consultancy fee.', effect: { type: 'money', amount: 25 } },
  { id: 'cc-repairs', deck: 'chest', text: 'You are assessed for street repairs: $40 per house, $115 per hotel.', effect: { type: 'repairs', perHouse: 40, perHotel: 115 } },
  { id: 'cc-beauty', deck: 'chest', text: 'You have won second prize in a beauty contest. Collect $10.', effect: { type: 'money', amount: 10 } },
  { id: 'cc-inherit', deck: 'chest', text: 'You inherit $100.', effect: { type: 'money', amount: 100 } },
];

export const CARD_BY_ID: Record<string, CardDef> = Object.fromEntries(CARDS.map((c) => [c.id, c]));
