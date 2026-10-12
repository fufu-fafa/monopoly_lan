import { useCallback, useEffect, useRef, useState } from 'react';
import type { Action, GameEvent, GameState, GameStats } from '@monopoly/engine';
import { useAnimator, type CardShown, type StateMsg } from './animator';

export type { CardShown } from './animator';

export interface SeatView { playerId: string; name: string; token: string; color: string; bot?: boolean; advanced?: boolean; watching?: boolean }
export interface LobbyOptions { startingCash: number; freeParkingJackpot: boolean; shuffleOrder: boolean }
export interface LobbyView {
  seats: SeatView[];
  adminId: string | null;
  options: LobbyOptions;
  started: boolean;
  presence: Record<string, boolean>;
}

export interface Toast { id: number; text: string; kind: 'error' | 'info' }

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
  const [stats, setStats] = useState<GameStats | null>(null);
  const [card, setCard] = useState<CardShown | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const toastId = useRef(1);
  const clientSeq = useRef(1);

  // State updates go through the animator so dice and tokens move before the new state shows.
  const applyState = useCallback((msg: StateMsg) => {
    setState(msg.state);
    setAuctionClosesAt(msg.auctionClosesAt);
    setClockOffset(msg.serverNow - Date.now());
    setLastEvents(msg.events);
    setStats(msg.stats ?? null);
  }, []);
  const anim = useAnimator(applyState, setCard);
  const animRef = useRef(anim);
  animRef.current = anim;

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
        animRef.current.reset(); // the host sends a fresh full state after hello
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
            if (!msg.started) { animRef.current.reset(); setState(null); }
            break;
          case 'presence':
            setPresence(msg.presence);
            break;
          case 'state': {
            animRef.current.enqueue(msg);
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
    online, me, lobby, state, presence, auctionClosesAt, clockOffset, toasts, lastEvents, card, stats,
    anim: anim.view, speed: anim.speed, setSpeed: anim.setSpeed,
    send, act, toast, dismissCard: () => setCard(null),
  };
}

export type Connection = ReturnType<typeof useConnection>;
