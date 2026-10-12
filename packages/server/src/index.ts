import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { WebSocketServer, WebSocket } from 'ws';
import { Room, type Client } from './room';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const clientDir = path.join(root, 'packages/client/dist');
const gamesDir = process.env.GAMES_DIR ?? path.join(root, 'games');
const port = Number(process.env.PORT ?? 3000);
const fresh = process.argv.includes('--new');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

const urls = () => lanAddresses().map((ip) => `http://${ip}:${port}`);

const room = new Room(gamesDir);
if (!fresh && room.resumeLatest()) console.log('Resumed the unfinished game from games/. Start with --new to ignore it.');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/api/info') {
    const list = urls();
    const main = list[0] ?? `http://localhost:${port}`;
    const qrSvg = await QRCode.toString(main, { type: 'svg', margin: 1 });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ urls: list, joinUrl: main, qrSvg }));
    return;
  }
  if (!fs.existsSync(clientDir)) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('The client is not built yet. Run "npm start" (or "npm run build") in the monopoly_lan folder.');
    return;
  }
  let file = path.normalize(path.join(clientDir, decodeURIComponent(url.pathname)));
  if (!file.startsWith(clientDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(clientDir, 'index.html');
  }
  // index.html must never be cached, or a browser keeps running an old build after an update.
  // Built assets have content hashes in their names, so they can be cached for good.
  const cache = file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': cache });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  const client: Client = {
    playerId: null,
    send: (msg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); },
  };
  room.connect(client);
  ws.on('message', (data) => {
    let msg: unknown;
    try { msg = JSON.parse(String(data)); } catch { return client.send({ type: 'error', message: 'Bad JSON' }); }
    room.handle(client, msg);
  });
  ws.on('close', () => room.disconnect(client));
});

// Keep phones' sockets alive and notice dead ones.
setInterval(() => {
  for (const ws of wss.clients) ws.ping();
}, 20_000).unref();

const onListenError = (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Is another copy of the game running? Try PORT=3001 npm start`);
    process.exit(1);
  }
  throw err;
};
server.on('error', onListenError);
wss.on('error', onListenError);

server.listen(port, '0.0.0.0', async () => {
  const list = urls();
  console.log('\n  Monopoly LAN host is running.\n');
  console.log(`  On this computer:  http://localhost:${port}`);
  for (const u of list) console.log(`  On your Wi-Fi:     ${u}`);
  if (list[0]) {
    console.log('\n  Players can scan this to join:\n');
    console.log(await QRCode.toString(list[0], { type: 'terminal', small: true }));
  }
  console.log('  If phones cannot connect: allow Node through the firewall when asked, and make sure');
  console.log('  everyone is on the same Wi-Fi (guest networks often block devices from seeing each other).\n');
});

const stop = () => { room.shutdown(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
