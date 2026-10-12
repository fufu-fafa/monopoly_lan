import { useEffect, useState } from 'react';
import type { Connection } from '../net';

export const TOKENS = ['🎩', '🚗', '🐕', '🚢', '👢', '🐈', '🦖', '🦆'];
export const COLORS = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00acc1', '#6d4c41', '#d81b60'];

interface Info { urls: string[]; joinUrl: string; qrSvg: string }

export function JoinInfo() {
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => {
    fetch('/api/info').then((r) => r.json()).then(setInfo).catch(() => setInfo(null));
  }, []);
  if (!info) return null;
  return (
    <div className="join-info">
      <div className="qr" dangerouslySetInnerHTML={{ __html: info.qrSvg }} />
      <div>
        <div className="muted">Others on the same Wi-Fi join at</div>
        {info.urls.length ? info.urls.map((u) => <div key={u} className="join-url">{u}</div>) : <div className="join-url">{location.origin}</div>}
      </div>
    </div>
  );
}

export function Lobby({ conn }: { conn: Connection }) {
  const { lobby, me, send, presence } = conn;
  const [name, setName] = useState('');
  const taken = new Set(lobby?.seats.flatMap((s) => [s.token, s.color.toLowerCase()]) ?? []);
  const [token, setToken] = useState<string | null>(null);
  const [color, setColor] = useState<string | null>(null);
  if (!lobby) return null;

  const pickToken = token && !taken.has(token) ? token : TOKENS.find((t) => !taken.has(t))!;
  const pickColor = color && !taken.has(color.toLowerCase()) ? color : COLORS.find((c) => !taken.has(c))!;
  const isAdmin = me !== null && me === lobby.adminId;
  const mySeat = lobby.seats.find((s) => s.playerId === me);
  const o = lobby.options;
  const playing = lobby.seats.filter((s) => !s.watching).length;

  return (
    <div className="lobby">
      <h1>Monopoly LAN</h1>
      <JoinInfo />

      {!mySeat && (
        <form
          className="card join-form"
          onSubmit={(e) => {
            e.preventDefault();
            send({ type: 'claimSeat', name, token: pickToken, color: pickColor });
          }}
        >
          <h2>Take a seat</h2>
          <label>
            Your name
            <input value={name} maxLength={20} onChange={(e) => setName(e.target.value)} placeholder="Name" autoFocus />
          </label>
          <div className="label">Token</div>
          <div className="choices">
            {TOKENS.map((t) => (
              <button type="button" key={t} disabled={taken.has(t)} className={`choice token-choice ${pickToken === t ? 'on' : ''}`} onClick={() => setToken(t)}>
                {t}
              </button>
            ))}
          </div>
          <div className="label">Colour</div>
          <div className="choices">
            {COLORS.map((c) => (
              <button type="button" key={c} disabled={taken.has(c)} aria-label={c} className={`choice swatch ${pickColor === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
          </div>
          <button className="primary" disabled={!name.trim() || playing >= 8}>
            {playing >= 8 ? 'The table is full' : 'Join the game'}
          </button>
        </form>
      )}

      <div className="card">
        <h2>Players ({playing}/8)</h2>
        {lobby.seats.length === 0 && <p className="muted">Nobody has joined yet.</p>}
        <ul className="seat-list">
          {lobby.seats.map((s) => (
            <li key={s.playerId}>
              <span className="seat-token" style={{ borderColor: s.color }}>{s.token}</span>
              <span className="seat-name">{s.name}{s.playerId === me && ' (you)'}</span>
              {s.playerId === lobby.adminId && <span className="badge">admin</span>}
              {s.bot && <span className="badge off">computer</span>}
              {s.bot && (isAdmin ? (
                <label className="row">
                  <input type="checkbox" checked={s.advanced !== false} onChange={(e) => send({ type: 'setBotLevel', playerId: s.playerId, advanced: e.target.checked })} />
                  Advanced
                </label>
              ) : s.advanced === false && <span className="badge off">basic</span>)}
              {s.watching && <span className="badge off">watching</span>}
              {s.bot && isAdmin && <button className="link" onClick={() => send({ type: 'removeBot', playerId: s.playerId })}>Remove</button>}
              {!presence[s.playerId] && <span className="badge off">offline</span>}
            </li>
          ))}
        </ul>
        {mySeat && !mySeat.bot && (
          <label className="row">
            <input type="checkbox" checked={!!mySeat.watching} onChange={(e) => send({ type: 'setWatching', watching: e.target.checked })} />
            Just watch (I won't play, e.g. to watch computer players)
          </label>
        )}
        <div className="row">
          {isAdmin && playing < 8 && (
            <button onClick={() => send({ type: 'addBot' })}>Add a computer player</button>
          )}
          {mySeat && <button className="link" onClick={() => send({ type: 'leaveSeat' })}>Leave my seat</button>}
        </div>
      </div>

      <div className="card">
        <h2>Game options</h2>
        {!isAdmin && <p className="muted">{lobby.seats.length ? 'The admin sets these and starts the game.' : 'The first player to join becomes the admin.'}</p>}
        <label className="row">
          Starting cash
          <select disabled={!isAdmin} value={o.startingCash} onChange={(e) => send({ type: 'setOptions', options: { startingCash: Number(e.target.value) } })}>
            {[1000, 1500, 2000, 2500].map((v) => <option key={v} value={v}>${v}</option>)}
          </select>
        </label>
        <label className="row">
          <input type="checkbox" disabled={!isAdmin} checked={o.freeParkingJackpot} onChange={(e) => send({ type: 'setOptions', options: { freeParkingJackpot: e.target.checked } })} />
          Free Parking jackpot (taxes and fines collect in the middle)
        </label>
        <label className="row">
          <input type="checkbox" disabled={!isAdmin} checked={o.shuffleOrder} onChange={(e) => send({ type: 'setOptions', options: { shuffleOrder: e.target.checked } })} />
          Random turn order (otherwise in joining order)
        </label>
        {isAdmin && (
          <button className="primary" disabled={playing < 2} onClick={() => send({ type: 'startGame' })}>
            {playing < 2 ? 'Waiting for at least 2 players' : mySeat?.watching ? 'Start the game and watch' : 'Start the game'}
          </button>
        )}
      </div>
    </div>
  );
}
