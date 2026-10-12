import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameEvent, GameState, GameStats } from '@monopoly/engine';

export type Speed = 'slow' | 'normal' | 'fast';
const SPEED_FACTOR: Record<Speed, number> = { slow: 1.6, normal: 1, fast: 0.55 };
const SPEED_KEY = 'monopoly-lan-speed';

// Base timings in ms, scaled by the speed setting.
const DICE_MS = 1000;      // dice tumble before they land
const AFTER_DICE_MS = 350; // pause on the landed dice before the token moves
const STEP_MS = 230;       // one space of token movement
const LONG_STEP_MS = 110;  // per space when a card sends a token far
const CARD_MS = 1600;      // time to read a card before its move happens
const SETTLE_MS = 350;     // pause after landing before the new state appears

export interface StateMsg { state: GameState; events: GameEvent[]; stats?: GameStats; auctionClosesAt: number | null; serverNow: number }

export interface CardShown { text: string; deck: 'chance' | 'chest'; playerId: string; at: number }

export interface AnimView {
  /** True while dice or tokens are animating; action buttons wait for it. */
  busy: boolean;
  /** Dice being shown, and whether they are still tumbling. */
  dice: { values: [number, number]; rolling: boolean } | null;
  /** Token positions during an animation, overriding the state's positions. */
  positions: Record<string, number> | null;
  /** The token that just hopped, so it can bounce. */
  hopping: string | null;
}

const IDLE: AnimView = { busy: false, dice: null, positions: null, hopping: null };

function readSpeed(): Speed {
  try {
    const v = window.localStorage.getItem(SPEED_KEY);
    return v === 'slow' || v === 'fast' ? v : 'normal';
  } catch {
    return 'normal';
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Plays each state update from the host in order: dice tumble, then the token walks
 * space by space, then the new state is shown. Updates queue up behind a running
 * animation; if several pile up (a slow phone catching up) they are applied at once.
 */
export function useAnimator(apply: (msg: StateMsg) => void, showCard: (c: CardShown) => void) {
  const [view, setView] = useState<AnimView>(IDLE);
  const [speed, setSpeedState] = useState<Speed>(readSpeed);
  const speedRef = useRef(speed);
  const queue = useRef<StateMsg[]>([]);
  const running = useRef(false);
  const shown = useRef<GameState | null>(null);
  const generation = useRef(0); // bumped by reset() to abandon a running animation

  const setSpeed = useCallback((s: Speed) => {
    speedRef.current = s;
    setSpeedState(s);
    try { window.localStorage.setItem(SPEED_KEY, s); } catch { /* per-device convenience only */ }
  }, []);

  const animate = useCallback(async (prev: GameState, events: GameEvent[], gen: number) => {
    const f = () => SPEED_FACTOR[speedRef.current];
    const live = () => generation.current === gen;
    const positions: Record<string, number> = Object.fromEntries(prev.players.map((p) => [p.id, p.position]));
    let dice: AnimView['dice'] = null;
    const show = (hopping: string | null = null) => setView({ busy: true, dice, positions: { ...positions }, hopping });
    show();

    for (let i = 0; i < events.length && live(); i++) {
      const ev = events[i];
      if (ev.type === 'diceRolled') {
        dice = { values: ev.dice, rolling: true };
        show();
        await wait(DICE_MS * f());
        dice = { values: ev.dice, rolling: false };
        show();
        await wait(AFTER_DICE_MS * f());
      } else if (ev.type === 'cardDrawn') {
        showCard({ text: ev.text, deck: ev.cardId.startsWith('ch-') ? 'chance' : 'chest', playerId: ev.playerId, at: Date.now() });
        await wait(CARD_MS * f());
      } else if (ev.type === 'moved') {
        const toJail = events[i + 1]?.type === 'sentToJail';
        const forward = (ev.to - ev.from + 40) % 40;
        const backward = !ev.passedGo && !toJail && forward > 20; // e.g. "Go back 3 spaces"
        if (toJail || forward === 0) {
          positions[ev.playerId] = ev.to;
          show(ev.playerId);
          await wait(STEP_MS * 2 * f());
        } else {
          const steps = backward ? 40 - forward : forward;
          const stepMs = (steps > 12 ? LONG_STEP_MS : STEP_MS) * f();
          for (let k = 1; k <= steps && live(); k++) {
            positions[ev.playerId] = (ev.from + (backward ? -k : k) + 40) % 40;
            show(ev.playerId);
            await wait(stepMs);
          }
        }
        await wait(SETTLE_MS * f());
      }
    }
  }, [showCard]);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    const gen = generation.current;
    while (queue.current.length && generation.current === gen) {
      const msg = queue.current.shift()!;
      const prev = shown.current;
      const catchUp = queue.current.length >= 3;
      const moving = msg.events.some((e) => e.type === 'diceRolled' || e.type === 'moved');
      // Step-by-step movement still plays with the OS "reduce motion" setting on (macOS and
      // iOS users often have it on); only the bounce effects are turned off, in style.css.
      if (prev && moving && !catchUp) {
        await animate(prev, msg.events, gen);
      } else {
        const drawn = msg.events.filter((e) => e.type === 'cardDrawn').pop();
        if (drawn?.type === 'cardDrawn') {
          showCard({ text: drawn.text, deck: drawn.cardId.startsWith('ch-') ? 'chance' : 'chest', playerId: drawn.playerId, at: Date.now() });
        }
      }
      if (generation.current !== gen) break;
      shown.current = msg.state;
      apply(msg);
      setView({ ...IDLE, busy: queue.current.length > 0 });
    }
    if (generation.current === gen) running.current = false;
  }, [animate, apply, showCard]);

  const enqueue = useCallback((msg: StateMsg) => {
    queue.current.push(msg);
    void run();
  }, [run]);

  /** Drops any queued or running animation (back to the lobby, or a fresh connection). */
  const reset = useCallback(() => {
    generation.current++;
    queue.current = [];
    shown.current = null;
    running.current = false;
    setView(IDLE);
  }, []);

  useEffect(() => () => { generation.current++; }, []);

  return { view, enqueue, reset, speed, setSpeed };
}
