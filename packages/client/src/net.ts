import { useCallback, useEffect, useRef, useState } from 'react';
import type { Action, GameEvent, GameState } from '@monopoly/engine';

export interface SeatView { playerId: string; name: string; token: string; color: string }
export interface LobbyOptions { startingCash: number; freeParkingJackpot: boolean; shuffleOrder: boolean }
export interface LobbyView {
  seats: SeatView[];
  adminId: string | null;
  options: LobbyOptions;
  started: boolean;
  presence: Record<string, boolean>;
}

export interface Toast { id: number; text: string; kind: 'error' | 'info' }
export interface CardShown { text: string; deck: 'chance' | 'chest'; playerId: string; at: number }

const SEAT_KEY = 'monopoly-lan-seat';

function storage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

export function useConnection() {
  const [online, setOnline] = useState(false);
  const [me, setMe] = useState<string | null>(null);
  const [lobby, setLobby] = useState<LobbyView | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [presence, setPresence] = useState<Record<string, boolean>>({});
  const [auctionClosesAt, setAuctionClosesAt] = useState<number | null>(null);
  const [clockOffset, setClockOffset] = useState(0); // serverNow - Date.now()
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [lastEvents, setLastEvents] = useState<GameEvent[]>([]);
  const [card, setCard] = useState<CardShown | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const toastId = useRef(1);
  const clientSeq = useRef(1);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'error') => {
    const id = toastId.current++;
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  useEffect(() => {
    let closed = false;
    let retry = 500;
    let timer: ReturnType<typeof setTimeout>;

    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const sock = new WebSocket(`${proto}://${location.host}/ws`);
      ws.current = sock;
      sock.onopen = () => {
        retry = 500;
        setOnline(true);
        sock.send(JSON.stringify({ type: 'hello', seatToken: storage()?.getItem(SEAT_KEY) ?? null }));
      };
      sock.onclose = () => {
        setOnline(false);
        if (!closed) timer = setTimeout(open, (retry = Math.min(retry * 2, 5000)));
      };
      sock.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        switch (msg.type) {
          case 'welcome':
            setMe(msg.playerId);
            if (msg.seatToken) storage()?.setItem(SEAT_KEY, msg.seatToken);
            else if (msg.playerId === null) storage()?.removeItem(SEAT_KEY);
            break;
          case 'lobby':
            setLobby(msg);
            setPresence(msg.presence);
            if (!msg.started) setState(null);
            break;
          case 'presence':
            setPresence(msg.presence);
            break;
          case 'state': {
            setState(msg.state);
            setAuctionClosesAt(msg.auctionClosesAt);
            setClockOffset(msg.serverNow - Date.now());
            setLastEvents(msg.events);
            const drawn = (msg.events as GameEvent[]).filter((ev) => ev.type === 'cardDrawn').pop();
            if (drawn && drawn.type === 'cardDrawn') {
              setCard({ text: drawn.text, deck: drawn.cardId.startsWith('ch-') ? 'chance' : 'chest', playerId: drawn.playerId, at: Date.now() });
            }
            break;
          }
          case 'rejected':
            toast(msg.reason);
            break;
          case 'error':
            toast(msg.message);
            break;
        }
      };
    };
    open();
    return () => {
      closed = true;
      clearTimeout(timer);
      ws.current?.close();
    };
  }, [toast]);

  const send = useCallback((msg: Record<string, unknown>) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(msg));
    else toast('Not connected to the host yet');
  }, [toast]);

  const act = useCallback((action: Action) => send({ type: 'action', action, clientSeq: clientSeq.current++ }), [send]);

  return {
    online, me, lobby, state, presence, auctionClosesAt, clockOffset, toasts, lastEvents, card,
    send, act, toast, dismissCard: () => setCard(null),
  };
}

export type Connection = ReturnType<typeof useConnection>;
