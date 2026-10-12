import { useConnection } from './net';
import { Lobby } from './components/Lobby';
import { Game } from './components/Game';

export function App() {
  const conn = useConnection();
  const { online, lobby, state, toasts } = conn;
  return (
    <>
      {!online && <div className="offline-bar">Connecting to the host…</div>}
      {!lobby ? <div className="lobby"><h1>Monopoly LAN</h1><p className="muted">Connecting…</p></div>
        : lobby.started && state ? <Game conn={conn} /> : <Lobby conn={conn} />}
      <div className="toasts" role="status">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </>
  );
}
