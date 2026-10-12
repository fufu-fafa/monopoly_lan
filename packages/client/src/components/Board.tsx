import type { ReactNode } from 'react';
import { BOARD, GROUP_COLORS, type GameState, type SpaceDef } from '@monopoly/engine';

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

const ICONS: Partial<Record<SpaceDef['kind'], string>> = {
  railroad: '🚂', chance: '❓', chest: '🧰', tax: '💰', go: '⬅️', jail: '🔒', freeParking: '🅿️', goToJail: '👮',
};

export function shortName(sp: SpaceDef): string {
  return sp.name
    .replace(' Avenue', ' Ave')
    .replace(' Railroad', ' RR')
    .replace('Jail / Just Visiting', 'Jail')
    .replace('Community Chest', 'Chest');
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
  return (
    <div className="board">
      {BOARD.map((sp) => {
        const { row, col } = gridPos(sp.index);
        const prop = state.properties[sp.index];
        const here = state.players.filter((p) => !p.bankrupt && (positions?.[p.id] ?? p.position) === sp.index);
        const owner = prop?.ownerId ? color(prop.ownerId) : undefined;
        return (
          <button
            key={sp.index}
            className={`space ${side(sp.index)} kind-${sp.kind} ${selected === sp.index ? 'selected' : ''} ${prop?.mortgaged ? 'mortgaged' : ''}`}
            style={{ gridRow: row, gridColumn: col, ...(owner ? { boxShadow: `inset 0 0 0 0.45cqw ${owner}` } : {}) }}
            onClick={() => onSpace(sp.index)}
            aria-label={sp.name}
          >
            {sp.kind === 'street' && (
              <div className="band" style={{ background: GROUP_COLORS[sp.group] }}>
                {prop.buildings === 5 ? <span className="hotel" /> : Array.from({ length: prop.buildings }, (_, k) => <span key={k} className="house" />)}
              </div>
            )}
            <div className="space-name">{ICONS[sp.kind] && <span className="icon">{ICONS[sp.kind]}</span>}{shortName(sp)}</div>
            {'price' in sp && !prop?.ownerId && <div className="price">${sp.price}</div>}
            {sp.kind === 'tax' && <div className="price">${sp.amount}</div>}
            {prop?.mortgaged && <div className="mort">MORTGAGED</div>}
            {here.length > 0 && (
              <div className="tokens">
                {here.map((p) => (
                  <span key={p.id} className={`token ${p.id === hopping ? 'hop' : p.id === state.turn.playerId && !positions ? 'active' : ''}`} style={{ borderColor: p.color }} title={p.name}>
                    {p.token}
                  </span>
                ))}
              </div>
            )}
          </button>
        );
      })}
      <div className="center">{children}</div>
    </div>
  );
}
