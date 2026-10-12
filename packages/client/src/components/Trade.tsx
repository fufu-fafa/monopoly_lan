import { useState } from 'react';
import {
  activePlayers, emptyAssets, GROUP_COLORS, ownedProperties, propertySpace, setHasBuildings, space, whyAssetsInvalid,
  type Assets, type GameState, type Player, type PlayerId,
} from '@monopoly/engine';

export function describeAssets(a: Assets): string {
  const parts: string[] = [];
  if (a.cash) parts.push(`$${a.cash}`);
  for (const i of a.properties) parts.push(space(i).name);
  for (const _ of a.jailCards) parts.push('Get Out of Jail Free');
  return parts.length ? parts.join(', ') : 'nothing';
}

function AssetPicker({ state, owner, value, onChange }: { state: GameState; owner: Player; value: Assets; onChange: (a: Assets) => void }) {
  const props = ownedProperties(state, owner.id).filter((i) => !setHasBuildings(state, i));
  const toggle = <T,>(list: T[], x: T) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);
  return (
    <div className="asset-picker">
      <label>
        Cash (max ${owner.cash})
        <input type="number" min={0} max={owner.cash} value={value.cash || ''} placeholder="0"
          onChange={(e) => onChange({ ...value, cash: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
      </label>
      {props.length === 0 && <div className="muted small">No tradeable property</div>}
      {props.map((i) => {
        const sp = propertySpace(i)!;
        return (
          <label key={i} className="row">
            <input type="checkbox" checked={value.properties.includes(i)} onChange={() => onChange({ ...value, properties: toggle(value.properties, i) })} />
            <span className="chip" style={{ background: sp.kind === 'street' ? GROUP_COLORS[sp.group] : '#555' }} />
            {sp.name}{state.properties[i].mortgaged && ' (mortgaged)'}
          </label>
        );
      })}
      {owner.jailCards.map((c) => (
        <label key={c} className="row">
          <input type="checkbox" checked={value.jailCards.includes(c)} onChange={() => onChange({ ...value, jailCards: toggle(value.jailCards, c) })} />
          Get Out of Jail Free
        </label>
      ))}
    </div>
  );
}

export function TradeBuilder({ state, me, initial, onSend, onClose }: {
  state: GameState;
  me: Player;
  initial: { to?: PlayerId; give?: Assets; get?: Assets };
  onSend: (offer: { to: PlayerId; give: Assets; get: Assets }) => void;
  onClose: () => void;
}) {
  const others = activePlayers(state).filter((p) => p.id !== me.id);
  const [to, setTo] = useState<PlayerId>(initial.to ?? others[0]?.id);
  const [give, setGive] = useState<Assets>(initial.give ?? emptyAssets());
  const [get, setGet] = useState<Assets>(initial.get ?? emptyAssets());
  const partner = others.find((p) => p.id === to);
  const problem = !partner ? 'Pick a player'
    : whyAssetsInvalid(state, me.id, give) ?? whyAssetsInvalid(state, partner.id, get)
      ?? (!give.cash && !give.properties.length && !give.jailCards.length && !get.cash && !get.properties.length && !get.jailCards.length ? 'Add something to the trade' : null);
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>Propose a trade</h2>
        <label className="row">
          With
          <select value={to} onChange={(e) => { setTo(e.target.value); setGet(emptyAssets()); }}>
            {others.map((p) => <option key={p.id} value={p.id}>{p.token} {p.name}</option>)}
          </select>
        </label>
        <div className="trade-cols">
          <div>
            <h3>You give</h3>
            <AssetPicker state={state} owner={me} value={give} onChange={setGive} />
          </div>
          <div>
            <h3>You get</h3>
            {partner && <AssetPicker state={state} owner={partner} value={get} onChange={setGet} />}
          </div>
        </div>
        <p className="small muted">Receiving a mortgaged property costs a 10% fee to the bank.</p>
        {problem && <p className="small warn">{problem}</p>}
        <div className="action-bar">
          <button className="primary" disabled={!!problem} onClick={() => onSend({ to, give, get })}>Send offer</button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
