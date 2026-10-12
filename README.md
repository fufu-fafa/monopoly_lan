# Monopoly LAN

A Monopoly game for a home network. One computer runs the host; everyone else plays from a phone or laptop browser on the same Wi-Fi.

## Run it

You need [Node.js](https://nodejs.org) 20 or newer on the host computer.

```
cd monopoly_lan
npm install      # first time only
npm start        # builds the web client and starts the host on port 3000
```

The terminal prints the address to join (for example `http://192.168.1.20:3000`) and a QR code. Open that address on each device, pick a name, token and colour, and take a seat. The first player to sit down is the admin: they choose starting cash, the Free Parking jackpot and turn order, then press **Start the game**.

- A browser that is not seated (for example a laptop on the TV) watches the board as a spectator.
- If a phone locks or a page is refreshed, it reconnects and gets its seat back automatically.
- If someone leaves for good, the admin can tap **Remove from game** next to them in the Players tab (their property goes back to the bank and is auctioned). A player can also tap **Leave game**.
- If the host stops mid-game, `npm start` again resumes the unfinished game. Use `npm run serve -- --new` to skip resuming. Games are saved in `games/`.
- Different port: `PORT=3001 npm start` (on Windows PowerShell: `$env:PORT=3001; npm start`).

**If phones can't connect:** allow Node through the firewall when Windows or macOS asks, and make sure everyone is on the same Wi-Fi. Guest networks often block devices from seeing each other.

## What the base version plays

Full standard rules: two dice with doubles (third double goes to jail), $200 GO salary, buying, live auctions on every device when a property is declined (sale closes 5 s after the last raise), rent including full sets, railroads and utilities, Chance and Community Chest, taxes, jail (fine, card or doubles for 3 turns), building evenly with the bank's 32 houses and 12 hotels, mortgages (+10% to lift), trades at any time except during an auction (cash, unimproved properties, jail cards; 10% fee on mortgaged property received), raising funds when short, bankruptcy to a player or to the bank (properties auctioned), and last player standing wins. Free Parking jackpot is an option at setup.

Not yet included (see `PLAN.md`): computer players, save slots and replay, undo, TV mode and animations, other house rules and boards.

## Project layout

```
packages/
  engine/   pure TypeScript rules: createGame, applyAction, legalActions, board and card data
  server/   Node host: serves the client, WebSocket lobby and game, auction timer, saves
  client/   Vite + React web client: lobby, board, auctions, trades, management
games/      saved games (action logs) written by the host
```

The host is the only place `applyAction` runs. Clients send intents; the server attaches the sender from the socket's seat, so a device can only act as its own player.

## Tests

```
npm test                          # engine rule tests + 300 random-bot games, then a full game through a real server with a crash and resume
SIM_GAMES=2500 npm test -w @monopoly/engine   # more simulated games
npm run typecheck
npm run dev:client                # client with hot reload (run `npm run serve` alongside)
```
