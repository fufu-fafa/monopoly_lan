import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  BOARD, GROUP_COLORS, legalActions, netWorth, ownedProperties, propertySpace, rentFor, space, totalDebt,
  unmortgageCost, waitingOn, whyCannotBuild, whyCannotMortgage, whyCannotSell, whyCannotUnmortgage,
  type Action, type Assets, type GameState, type GameStats, type Player, type TradeOffer,
} from '@monopoly/engine';
import type { Connection } from '../net';
import type { Speed } from '../animator';
import { Board } from './Board';
import { TradeBuilder, describeAssets } from './Trade';

const DIE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

function useNarrow() {
  const query = '(max-width: 900px)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
}

function useNow(ms = 250) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function Game({ conn }: { conn: Connection }) {
  const { state, me, act, lobby, send, presence } = conn;
  const [selected, setSelected] = useState<number | null>(null);
  const [tab, setTab] = useState<'players' | 'manage' | 'trades' | 'log'>('players');
  const [trade, setTrade] = useState<{ to?: string; give?: Assets; get?: Assets } | null>(null);
  const narrow = useNarrow();
  if (!state) return null;

  const meP = state.players.find((p) => p.id === me) ?? null;
  const legal = me ? legalActions(state, me) : [];
  const incoming = state.trades.filter((t) => t.to === me).length;
  const isAdmin = me !== null && me === lobby?.adminId;

  return (
    <div className="game">
      <div className="board-wrap">
        <Board state={state} onSpace={setSelected} selected={selected} positions={conn.anim.positions} hopping={conn.anim.hopping}>
          <Center conn={conn} me={meP}>{!narrow && <Controls conn={conn} legal={legal} me={meP} />}</Center>
        </Board>
      </div>
      {/* On phones the board centre is too small for buttons, so they sit under the board. */}
      {narrow && <div className="controls-below"><Controls conn={conn} legal={legal} me={meP} /></div>}

      <aside className="side">
        {meP && <MyStatus state={state} me={meP} />}
        {!meP && <div className="card muted">You are watching this game.</div>}
        <nav className="tabs">
          <button className={tab === 'players' ? 'on' : ''} onClick={() => setTab('players')}>Players</button>
          {meP && <button className={tab === 'manage' ? 'on' : ''} onClick={() => setTab('manage')}>My properties</button>}
          {meP && (
            <button className={tab === 'trades' ? 'on' : ''} onClick={() => setTab('trades')}>
              Trades{incoming > 0 && <span className="dot">{incoming}</span>}
            </button>
          )}
          <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>Log</button>
        </nav>
        <div className="tab-body">
          {tab === 'players' && (
            <Players state={state} presence={presence} me={me} isAdmin={isAdmin}
              onRemove={(p) => confirm(`Remove ${p.name} from the game? Their property goes back to the bank.`) && send({ type: 'removePlayer', playerId: p.id })} />
          )}
          {tab === 'manage' && meP && <Manage state={state} me={meP} act={act} onSpace={setSelected} />}
          {tab === 'trades' && meP && <Trades state={state} me={meP} act={act} onNew={(t) => setTrade(t ?? {})} />}
          {tab === 'log' && (
            <>
              {conn.stats && <Stats state={state} stats={conn.stats} />}
              <h3>Events</h3>
              <Log state={state} />
            </>
          )}
        </div>
        <label className="row small speed">
          Game speed
          <select value={conn.speed} onChange={(e) => conn.setSpeed(e.target.value as Speed)}>
            <option value="slow">Slow</option>
            <option value="normal">Normal</option>
            <option value="fast">Fast</option>
          </select>
        </label>
        {meP && !meP.bankrupt && !state.winner && (
          <button className="link danger" onClick={() => confirm('Leave the game? Your property goes back to the bank and you cannot rejoin.') && act({ type: 'LEAVE_GAME' })}>
            Leave game
          </button>
        )}{' '}
        {isAdmin && !state.winner && (
          <button className="link danger" onClick={() => confirm('End this game for everyone and go back to the lobby?') && send({ type: 'endGame' })}>
            End game (admin)
          </button>
        )}
      </aside>

      {selected !== null && <SpaceDetail state={state} index={selected} me={me} act={act} onClose={() => setSelected(null)} />}
      {trade && meP && (
        <TradeBuilder state={state} me={meP} initial={trade} onClose={() => setTrade(null)}
          onSend={(offer) => { act({ type: 'PROPOSE_TRADE', offer }); setTrade(null); setTab('trades'); }} />
      )}
      {incoming > 0 && tab !== 'trades' && meP && (
        <button className="trade-alert" onClick={() => setTab('trades')}>You have {incoming} trade offer{incoming > 1 ? 's' : ''}</button>
      )}
      {state.winner && <GameOver state={state} isAdmin={isAdmin} onLobby={() => send({ type: 'endGame' })} />}
    </div>
  );
}

// ------------------------------------------------------------------ centre of the board

function Center({ conn, me, children }: { conn: Connection; me: Player | null; children: ReactNode }) {
  const { state, card, dismissCard, presence, lobby } = conn;
  useEffect(() => {
    if (!card) return;
    const t = setTimeout(dismissCard, 7000);
    return () => clearTimeout(t);
  }, [card, dismissCard]);
  if (!state) return null;

  const turnP = state.players.find((p) => p.id === state.turn.playerId)!;
  const waiting = waitingOn(state);
  const name = (id: string) => (id === me?.id ? 'you' : state.players.find((p) => p.id === id)?.name ?? id);
  let banner: string;
  if (state.winner) banner = `${name(state.winner) === 'you' ? 'You win' : `${name(state.winner)} wins`}!`;
  else if (state.pending?.type === 'auction') banner = `Auction: ${space(state.pending.space).name}`;
  else if (state.debts.length) banner = `Waiting for ${waiting.map(name).join(', ')} to settle debts`;
  else if (turnP.id === me?.id) banner = 'Your turn';
  else banner = `${turnP.name}'s turn`;
  const offline = state.winner ? [] : waiting.filter((id) => id !== me?.id && !presence[id]);
  const isAdmin = conn.me !== null && conn.me === lobby?.adminId; // the admin may be watching, not playing

  return (
    <div className="center-inner">
      <div className="banner" style={{ background: turnP.color }}>{turnP.token} {banner}</div>
      {offline.length > 0 && (
        <div className="offline-note">
          {offline.map((id) => state.players.find((p) => p.id === id)!.name).join(', ')} {offline.length > 1 ? 'are' : 'is'} offline; the game waits for them to reconnect.
          {isAdmin && ' If they have left, remove them in the Players tab.'}
        </div>
      )}
      <Dice values={conn.anim.dice?.values ?? state.turn.lastRoll} rolling={!!conn.anim.dice?.rolling} />
      {card && (
        <button className={`drawn-card ${card.deck}`} onClick={dismissCard}>
          <div className="deck-name">{card.deck === 'chance' ? 'Chance' : 'Community Chest'} · {name(card.playerId)}</div>
          {card.text}
        </button>
      )}
      {state.rules.freeParkingJackpot && <div className="pot">Free Parking pot: ${state.bank.freeParkingPot}</div>}
      {children}
      <div className="last-log">{state.log.slice(-2).map((l, i) => <div key={i}>{l}</div>)}</div>
    </div>
  );
}

function Dice({ values, rolling }: { values: [number, number] | null; rolling: boolean }) {
  const [faces, setFaces] = useState<[number, number]>([1, 1]);
  useEffect(() => {
    if (!rolling) return;
    const t = setInterval(() => setFaces([1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)]), 80);
    return () => clearInterval(t);
  }, [rolling]);
  if (!values) return null;
  const shown = rolling ? faces : values;
  return (
    <div className={`dice ${rolling ? 'rolling' : 'landed'}`} aria-label={rolling ? 'Rolling dice' : `Dice ${values.join(' and ')}`}>
      <span className="die">{DIE[shown[0]]}</span>
      <span className="die">{DIE[shown[1]]}</span>
    </div>
  );
}

function Controls({ conn, legal, me }: { conn: Connection; legal: Action[]; me: Player | null }) {
  const { state, act } = conn;
  const now = useNow();
  if (!state) return null;
  // Buttons wait until the dice and tokens have finished moving.
  if (conn.anim.busy) return <div className="action-bar"><span className="muted small">…</span></div>;
  return (
    <>
      {state.pending?.type === 'auction' && <AuctionPanel conn={conn} now={now} legal={legal} />}
      {me && <DebtPanel state={state} me={me} legal={legal} act={act} />}
      {me && state.pending?.type !== 'auction' && <ActionBar state={state} legal={legal} act={act} />}
      {!me && <div className="muted small">Spectating</div>}
    </>
  );
}

function ActionBar({ state, legal, act }: { state: GameState; legal: Action[]; act: (a: Action) => void }) {
  const buttons: { label: string; action: Action; primary?: boolean }[] = [];
  for (const a of legal) {
    switch (a.type) {
      case 'ROLL_DICE': buttons.push({ label: state.turn.rollAgain ? 'Roll again (doubles)' : 'Roll dice', action: a, primary: true }); break;
      case 'END_TURN': buttons.push({ label: 'End turn', action: a, primary: true }); break;
      case 'BUY': {
        const sp = propertySpace((state.pending as { space: number }).space)!;
        buttons.push({ label: `Buy ${sp.name} for $${sp.price}`, action: a, primary: true });
        break;
      }
      case 'DECLINE_BUY': buttons.push({ label: 'Auction it', action: a }); break;
      case 'PAY_JAIL_FINE': buttons.push({ label: `Pay $${state.rules.jailFine} to leave jail`, action: a }); break;
      case 'USE_JAIL_CARD': buttons.push({ label: 'Use Get Out of Jail Free', action: a }); break;
    }
  }
  const pending = state.pending;
  return (
    <div className="action-bar">
      {pending?.type === 'buyOrAuction' && !legal.some((a) => a.type === 'DECLINE_BUY') && (
        <div className="muted small">Deciding on {space(pending.space).name}…</div>
      )}
      {buttons.map((b) => (
        <button key={b.label} className={b.primary ? 'primary' : ''} onClick={() => act(b.action)}>{b.label}</button>
      ))}
    </div>
  );
}

function AuctionPanel({ conn, now, legal }: { conn: Connection; now: number; legal: Action[] }) {
  const { state, act, auctionClosesAt, clockOffset, me } = conn;
  const [custom, setCustom] = useState('');
  if (state?.pending?.type !== 'auction') return null;
  const a = state.pending;
  const sp = propertySpace(a.space)!;
  const left = auctionClosesAt ? Math.max(0, Math.ceil((auctionClosesAt - (now + clockOffset)) / 1000)) : null;
  const canBid = legal.some((x) => x.type === 'BID');
  const canPass = legal.some((x) => x.type === 'PASS_BID');
  const myCash = state.players.find((p) => p.id === me)?.cash ?? 0;
  const bid = (amount: number) => act({ type: 'BID', amount: Math.min(amount, myCash) });
  const highName = a.highBidder ? state.players.find((p) => p.id === a.highBidder)!.name : null;
  return (
    <div className="auction">
      <div className="auction-title">{sp.name} <span className="muted">(list ${sp.price})</span></div>
      <div className="auction-high">{highName ? <>High bid <b>${a.highBid}</b> by {highName}</> : 'No bids yet'}</div>
      {left !== null && <div className={`countdown ${left <= 2 ? 'hot' : ''}`}>Closes in {left}s</div>}
      <div className="muted small">Still in: {a.bidders.map((id) => state.players.find((p) => p.id === id)!.name).join(', ')}</div>
      {canBid && (
        <div className="bid-buttons">
          {[1, 10, 50, 100].map((n) => (
            <button key={n} className="primary" disabled={a.highBid + n > myCash} onClick={() => bid(a.highBid + n)}>+${n}</button>
          ))}
          <form onSubmit={(e) => { e.preventDefault(); const v = Number(custom); if (v) bid(v); setCustom(''); }}>
            <input type="number" min={a.highBid + 1} max={myCash} placeholder={`$${a.highBid + 1}+`} value={custom} onChange={(e) => setCustom(e.target.value)} />
            <button>Bid</button>
          </form>
        </div>
      )}
      {canPass && <button onClick={() => act({ type: 'PASS_BID' })}>Pass</button>}
      {me && a.highBidder === me && <div className="small">You hold the high bid.</div>}
      {me && !a.bidders.includes(me) && <div className="muted small">You are out of this auction.</div>}
    </div>
  );
}

function DebtPanel({ state, me, legal, act }: { state: GameState; me: Player; legal: Action[]; act: (a: Action) => void }) {
  const owed = totalDebt(state, me.id);
  if (!owed) return null;
  const short = owed - me.cash;
  return (
    <div className="debt">
      <div><b>You owe ${owed}.</b> {short > 0 ? `You are $${short} short: sell buildings, mortgage or trade to raise it.` : 'You can pay now.'}</div>
      <div className="action-bar">
        {legal.some((a) => a.type === 'PAY_DEBT') && <button className="primary" onClick={() => act({ type: 'PAY_DEBT' })}>Pay ${owed}</button>}
        <button className="danger" onClick={() => confirm('Declare bankruptcy? You will be out of the game.') && act({ type: 'DECLARE_BANKRUPTCY' })}>
          Declare bankruptcy
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ side panels

function MyStatus({ state, me }: { state: GameState; me: Player }) {
  return (
    <div className="card my-status" style={{ borderColor: me.color }}>
      <span className="big-token">{me.token}</span>
      <div>
        <div className="my-name">{me.name}{me.bankrupt && ' (bankrupt)'}</div>
        <div className="my-cash">${me.cash}</div>
      </div>
      <div className="muted small right">
        {me.inJail && <div>🔒 In jail</div>}
        {me.jailCards.length > 0 && <div>🎟 {me.jailCards.length} jail card{me.jailCards.length > 1 ? 's' : ''}</div>}
        <div>Net worth ${netWorth(state, me.id)}</div>
      </div>
    </div>
  );
}

function Players({ state, presence, me, isAdmin, onRemove }: {
  state: GameState; presence: Record<string, boolean>; me: string | null; isAdmin: boolean; onRemove: (p: Player) => void;
}) {
  return (
    <ul className="players">
      {state.turnOrder.map((id) => {
        const p = state.players.find((x) => x.id === id)!;
        return (
          <li key={id} className={`${p.bankrupt ? 'out' : ''} ${state.turn.playerId === id ? 'current' : ''}`} style={{ borderLeftColor: p.color }}>
            <div className="player-head">
              <span>{p.token} <b>{p.name}</b>{id === me && ' (you)'}</span>
              <span>{p.bankrupt ? 'Out' : `$${p.cash}`}</span>
            </div>
            <div className="muted small">
              {!presence[id] && !p.bankrupt && <span className="badge off">offline</span>}
              {p.inJail && ' 🔒 in jail'}
              {p.jailCards.length > 0 && ` 🎟 ${p.jailCards.length}`}
              {!p.bankrupt && ` · on ${space(p.position).name}`}
            </div>
            {isAdmin && id !== me && !p.bankrupt && !state.winner && (
              <button className="link danger small" disabled={state.pending?.type === 'auction'} onClick={() => onRemove(p)}>
                Remove from game
              </button>
            )}
            {/* One row per colour set, then railroads and utilities on rows of their own. */}
            <div className="chips">
              {chipRows(ownedProperties(state, id)).map((row) => (
                <div key={row[0]} className="chip-row">
                  {row.map((i) => {
                    const sp = BOARD[i];
                    const bg = sp.kind === 'street' ? GROUP_COLORS[sp.group] : sp.kind === 'railroad' ? '#333' : '#8a8a8a';
                    return <span key={i} className={`chip ${state.properties[i].mortgaged ? 'mortgaged' : ''}`} style={{ background: bg }} title={sp.name} />;
                  })}
                </div>
              ))}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Groups owned property indices by set (colour group, railroads, utilities), in board order. */
function chipRows(owned: number[]): number[][] {
  const rows = new Map<string, number[]>();
  for (const i of [...owned].sort((a, b) => a - b)) {
    const sp = BOARD[i];
    const key = sp.kind === 'street' ? `street-${sp.group}` : sp.kind;
    rows.set(key, [...(rows.get(key) ?? []), i]);
  }
  const streets = [...rows].filter(([k]) => k.startsWith('street-')).map(([, v]) => v);
  return [...streets, rows.get('railroad'), rows.get('utility')].filter((r): r is number[] => !!r);
}

function Manage({ state, me, act, onSpace }: { state: GameState; me: Player; act: (a: Action) => void; onSpace: (i: number) => void }) {
  const mine = ownedProperties(state, me.id);
  if (!mine.length) return <p className="muted">You don't own any property yet.</p>;
  return (
    <ul className="manage">
      {mine.map((i) => <ManageRow key={i} state={state} me={me} index={i} act={act} onSpace={onSpace} />)}
    </ul>
  );
}

function ManageRow({ state, me, index, act, onSpace }: { state: GameState; me: Player; index: number; act: (a: Action) => void; onSpace?: (i: number) => void }) {
  const sp = propertySpace(index)!;
  const prop = state.properties[index];
  const build = whyCannotBuild(state, me.id, index);
  const sell = whyCannotSell(state, me.id, index);
  const mort = whyCannotMortgage(state, me.id, index);
  const unmort = whyCannotUnmortgage(state, me.id, index);
  return (
    <li>
      <button className="link prop-name" onClick={() => onSpace?.(index)}>
        <span className="chip" style={{ background: sp.kind === 'street' ? GROUP_COLORS[sp.group] : '#555' }} />
        {sp.name}
      </button>
      <span className="muted small">
        {prop.mortgaged ? 'mortgaged' : prop.buildings === 5 ? 'hotel' : prop.buildings ? `${prop.buildings} house${prop.buildings > 1 ? 's' : ''}` : ''}
      </span>
      <div className="manage-buttons">
        {sp.kind === 'street' && (
          <>
            <button disabled={!!build} title={build ?? `Costs $${sp.houseCost}`} onClick={() => act({ type: 'BUILD', space: index })}>Build ${sp.houseCost}</button>
            <button disabled={!!sell} title={sell ?? `Refunds $${sp.houseCost / 2}`} onClick={() => act({ type: 'SELL_BUILDING', space: index })}>Sell ${sp.houseCost / 2}</button>
          </>
        )}
        {prop.mortgaged ? (
          <button disabled={!!unmort} title={unmort ?? ''} onClick={() => act({ type: 'UNMORTGAGE', space: index })}>Unmortgage ${unmortgageCost(state, index)}</button>
        ) : (
          <button disabled={!!mort} title={mort ?? ''} onClick={() => act({ type: 'MORTGAGE', space: index })}>Mortgage +${sp.mortgage}</button>
        )}
      </div>
    </li>
  );
}

function Trades({ state, me, act, onNew }: { state: GameState; me: Player; act: (a: Action) => void; onNew: (t?: { to: string; give: Assets; get: Assets }) => void }) {
  const name = (id: string) => state.players.find((p) => p.id === id)!.name;
  const incoming = state.trades.filter((t) => t.to === me.id);
  const outgoing = state.trades.filter((t) => t.from === me.id);
  const blocked = state.pending?.type === 'auction';
  const row = (t: TradeOffer, mineIsFrom: boolean) => (
    <li key={t.id} className="trade-row">
      <div><b>{mineIsFrom ? `To ${name(t.to)}` : `From ${name(t.from)}`}</b></div>
      <div className="small">You give: {describeAssets(mineIsFrom ? t.give : t.get)}</div>
      <div className="small">You get: {describeAssets(mineIsFrom ? t.get : t.give)}</div>
      <div className="manage-buttons">
        {mineIsFrom ? (
          <button onClick={() => act({ type: 'WITHDRAW_TRADE', tradeId: t.id })}>Withdraw</button>
        ) : (
          <>
            <button className="primary" disabled={blocked} onClick={() => act({ type: 'ACCEPT_TRADE', tradeId: t.id })}>Accept</button>
            <button onClick={() => act({ type: 'REJECT_TRADE', tradeId: t.id })}>Reject</button>
            <button disabled={blocked} onClick={() => { act({ type: 'REJECT_TRADE', tradeId: t.id }); onNew({ to: t.from, give: t.get, get: t.give }); }}>Counter</button>
          </>
        )}
      </div>
    </li>
  );
  return (
    <div>
      <button className="primary" disabled={blocked || !!state.winner} onClick={() => onNew()}>New trade</button>
      {blocked && <div className="muted small">No trading during an auction.</div>}
      <h3>Offers to you</h3>
      {incoming.length ? <ul className="trades">{incoming.map((t) => row(t, false))}</ul> : <p className="muted small">None</p>}
      <h3>Your offers</h3>
      {outgoing.length ? <ul className="trades">{outgoing.map((t) => row(t, true))}</ul> : <p className="muted small">None</p>}
    </div>
  );
}

/** Per-player totals for the game so far, plus the spaces landed on most. */
function Stats({ state, stats }: { state: GameState; stats: GameStats }) {
  const players = state.turnOrder.map((id) => state.players.find((p) => p.id === id)!);
  const st = (id: string) => stats.players[id];
  const money = (n: number) => `$${n}`;
  const rows: [string, (p: Player) => string | number][] = [
    ['Net worth', (p) => (p.bankrupt ? 'out' : money(netWorth(state, p.id)))],
    ['Properties owned', (p) => ownedProperties(state, p.id).length],
    ['Properties bought', (p) => st(p.id)?.propertiesBought ?? 0],
    ['Rent received', (p) => money(st(p.id)?.rentReceived ?? 0)],
    ['Rent paid', (p) => money(st(p.id)?.rentPaid ?? 0)],
    ['Taxes and fees', (p) => money(st(p.id)?.taxesAndFees ?? 0)],
    ['Spent on houses', (p) => money(st(p.id)?.spentOnBuildings ?? 0)],
    ['Passed GO', (p) => st(p.id)?.passedGo ?? 0],
    ['Dice rolls', (p) => st(p.id)?.rolls ?? 0],
    ['Doubles', (p) => st(p.id)?.doubles ?? 0],
    ['Sent to jail', (p) => st(p.id)?.timesInJail ?? 0],
    ['Cards drawn', (p) => st(p.id)?.cardsDrawn ?? 0],
  ];
  const top = Object.entries(stats.landings).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return (
    <div className="stats">
      <h3>Statistics <span className="muted small">turn {state.turn.number}</span></h3>
      <div className="stats-scroll">
        <table className="stats-table">
          <thead>
            <tr><th />{players.map((p) => <th key={p.id} title={p.name} style={{ borderBottomColor: p.color }}>{p.token}<div className="small">{p.name}</div></th>)}</tr>
          </thead>
          <tbody>
            {rows.map(([label, f]) => <tr key={label}><td>{label}</td>{players.map((p) => <td key={p.id}>{f(p)}</td>)}</tr>)}
          </tbody>
        </table>
      </div>
      {top.length > 0 && (
        <>
          <div className="small muted stats-sub">Landed on most</div>
          <ol className="stats-top">{top.map(([i, n]) => <li key={i}>{BOARD[Number(i)].name} <span className="muted">×{n}</span></li>)}</ol>
        </>
      )}
    </div>
  );
}

function Log({ state }: { state: GameState }) {
  const lines = useMemo(() => state.log.slice().reverse(), [state.log]);
  return <ol className="log" aria-live="polite">{lines.map((l, i) => <li key={lines.length - i}>{l}</li>)}</ol>;
}

// ------------------------------------------------------------------ modals

function SpaceDetail({ state, index, me, act, onClose }: { state: GameState; index: number; me: string | null; act: (a: Action) => void; onClose: () => void }) {
  const sp = space(index);
  const prop = state.properties[index];
  const owner = prop?.ownerId ? state.players.find((p) => p.id === prop.ownerId) : null;
  const meP = state.players.find((p) => p.id === me);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {sp.kind === 'street' && <div className="deed-band" style={{ background: GROUP_COLORS[sp.group] }} />}
        <h2>{sp.name}</h2>
        {sp.kind === 'street' && (
          <table className="rent-table">
            <tbody>
              <tr><td>Rent</td><td>${sp.rent[0]} (${sp.rent[0] * 2} with the full set)</td></tr>
              {[1, 2, 3, 4].map((h) => <tr key={h}><td>With {h} house{h > 1 ? 's' : ''}</td><td>${sp.rent[h]}</td></tr>)}
              <tr><td>With hotel</td><td>${sp.rent[5]}</td></tr>
              <tr><td>House cost</td><td>${sp.houseCost}</td></tr>
            </tbody>
          </table>
        )}
        {sp.kind === 'railroad' && <p>Rent $25 / $50 / $100 / $200 for 1–4 railroads owned.</p>}
        {sp.kind === 'utility' && <p>Rent is 4× the dice with one utility, 10× with both.</p>}
        {sp.kind === 'tax' && <p>Pay ${sp.amount}.</p>}
        {'price' in sp && <p>Price ${sp.price} · Mortgage ${sp.mortgage}</p>}
        {prop && (
          <p>
            {owner ? <>Owned by <b>{owner.name}</b>{prop.mortgaged ? ' (mortgaged)' : ` · current rent $${rentFor(state, index)}${sp.kind === 'utility' ? ' for a roll of 7' : ''}`}</> : 'Owned by the bank'}
          </p>
        )}
        {meP && owner?.id === meP.id && <ul className="manage"><ManageRow state={state} me={meP} index={index} act={act} /></ul>}
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function GameOver({ state, isAdmin, onLobby }: { state: GameState; isAdmin: boolean; onLobby: () => void }) {
  const winner = state.players.find((p) => p.id === state.winner)!;
  return (
    <div className="modal-bg">
      <div className="modal">
        <h2>🏆 {winner.name} wins!</h2>
        <p>Final cash ${winner.cash}, net worth ${netWorth(state, winner.id)} after {state.turn.number} turns.</p>
        {isAdmin ? <button className="primary" onClick={onLobby}>Back to the lobby</button> : <p className="muted">The admin can start a new game.</p>}
      </div>
    </div>
  );
}
