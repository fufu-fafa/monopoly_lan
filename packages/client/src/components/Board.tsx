import type { ReactNode } from 'react';
import { BOARD, GROUP_COLORS, type GameState, type Player, type SpaceDef } from '@monopoly/engine';

/** Grid row/column (1-based) of each space: GO bottom-right, then clockwise. */
export function gridPos(i: number): { row: number; col: number } {
  if (i <= 10) return { row: 11, col: 11 - i };
  if (i <= 20) return { row: 11 - (i - 10), col: 1 };
  if (i <= 30) return { row: 1, col: 1 + (i - 20) };
  return { row: 1 + (i - 30), col: 11 };
}

function side(i: number): 'bottom' | 'left' | 'top' | 'right' | 'corner' {
  if (i % 10 === 0) return 'corner';
  if (i < 10) return 'bottom';
  if (i < 20) return 'left';
  if (i < 30) return 'top';
  return 'right';
}

export function shortName(sp: SpaceDef): string {
  return sp.name
    .replace(' Avenue', ' Ave')
    .replace(' Railroad', ' RR')
    .replace('Jail / Just Visiting', 'Jail')
    .replace('Community Chest', 'Chest');
}

/** Name as printed on the classic board. */
function boardName(sp: SpaceDef): string {
  if (sp.kind === 'chest') return 'Community Chest';
  return sp.name;
}

function SpaceArt({ sp }: { sp: SpaceDef }) {
  switch (sp.kind) {
    case 'railroad': return <span className="art">🚂</span>;
    case 'utility': return <span className="art">{sp.index === 12 ? '💡' : '🚰'}</span>;
    case 'chance': return <span className={`art chance-q c${sp.index}`}>?</span>;
    case 'chest': return <span className="art">🧰</span>;
    case 'tax': return <span className="art">{sp.index === 38 ? '💍' : '◆'}</span>;
    default: return null;
  }
}

function Tokens({ players, turnId, hopping, still }: { players: Player[]; turnId: string; hopping?: string | null; still: boolean }) {
  if (!players.length) return null;
  return (
    <div className="tokens">
      {players.map((p) => (
        <span key={p.id} className={`token ${p.id === hopping ? 'hop' : p.id === turnId && still ? 'active' : ''}`} style={{ borderColor: p.color }} title={p.name}>
          {p.token}
        </span>
      ))}
    </div>
  );
}

function Corner({ index }: { index: number }) {
  if (index === 0) {
    return (
      <div className="corner-face go">
        <div className="small-print">Collect $200 salary as you pass</div>
        <div className="go-word">GO</div>
        <div className="go-arrow">⬅</div>
      </div>
    );
  }
  if (index === 20) {
    return (
      <div className="corner-face parking">
        <div className="corner-word">Free</div>
        <div className="corner-art">🚗</div>
        <div className="corner-word">Parking</div>
      </div>
    );
  }
  return (
    <div className="corner-face gotojail">
      <div className="corner-word">Go to</div>
      <div className="corner-art">👮</div>
      <div className="corner-word">Jail</div>
    </div>
  );
}

export function Board({ state, onSpace, selected, children, positions, hopping }: {
  state: GameState;
  positions?: Record<string, number> | null;
  hopping?: string | null;
  onSpace: (i: number) => void;
  selected: number | null;
  children: ReactNode;
}) {
  const color = (id: string | null) => state.players.find((p) => p.id === id)?.color;
  const at = (i: number) => state.players.filter((p) => !p.bankrupt && (positions?.[p.id] ?? p.position) === i);
  const still = !positions;
  return (
    <div className="board classic">
      {BOARD.map((sp) => {
        const { row, col } = gridPos(sp.index);
        const prop = state.properties[sp.index];
        const here = at(sp.index);
        const owner = prop?.ownerId ? color(prop.ownerId) : undefined;
        const s = side(sp.index);
        return (
          <button
            key={sp.index}
            className={`space ${s} kind-${sp.kind} ${selected === sp.index ? 'selected' : ''} ${prop?.mortgaged ? 'mortgaged' : ''}`}
            style={{ gridRow: row, gridColumn: col }}
            onClick={() => onSpace(sp.index)}
            aria-label={sp.name}
          >
            {sp.kind === 'jail' ? (
              // Jail: the "In Jail" cell sits in the inner corner; visitors stand on the outer L.
              <div className="jail-corner">
                <div className="jail-cell">
                  <div className="bars" />
                  <div className="jail-word">In Jail</div>
                  <Tokens players={here.filter((p) => p.inJail && !positions)} turnId={state.turn.playerId} hopping={hopping} still={still} />
                </div>
                <div className="just">Just</div>
                <div className="visiting">Visiting</div>
                <div className="visitors">
                  <Tokens players={here.filter((p) => !p.inJail || positions)} turnId={state.turn.playerId} hopping={hopping} still={still} />
                </div>
              </div>
            ) : s === 'corner' ? (
              <>
                <Corner index={sp.index} />
                <Tokens players={here} turnId={state.turn.playerId} hopping={hopping} still={still} />
              </>
            ) : (
              <>
                <div className="face">
                  {sp.kind === 'street' ? (
                    <div className="band" style={{ background: GROUP_COLORS[sp.group] }}>
                      {prop.buildings === 5 ? <span className="hotel" /> : Array.from({ length: prop.buildings }, (_, k) => <span key={k} className="house" />)}
                    </div>
                  ) : null}
                  <div className="space-name">{boardName(sp)}</div>
                  <SpaceArt sp={sp} />
                  {sp.kind === 'tax' && <div className="price">Pay ${sp.amount}</div>}
                  {'price' in sp && <div className="price">${sp.price}</div>}
                  {owner && <div className="owner-strip" style={{ background: owner }} />}
                  {prop?.mortgaged && <div className="mort">Mortgaged</div>}
                </div>
                <Tokens players={here} turnId={state.turn.playerId} hopping={hopping} still={still} />
              </>
            )}
          </button>
        );
      })}
      {/* Logo on top, game controls in the middle, card decks along the bottom: each in its own row so nothing overlaps. */}
      <div className="center">
        <div className="logo-row" aria-hidden="true"><div className="logo-banner">MONOPOLY</div></div>
        <div className="center-play">{children}</div>
        <div className="deck-row" aria-hidden="true">
          <div className="deck-slot chest-slot"><span className="deck-icon">🧰</span><span>Community Chest</span></div>
          <div className="deck-slot chance-slot"><span className="deck-icon">?</span><span>Chance</span></div>
        </div>
      </div>
    </div>
  );
}
