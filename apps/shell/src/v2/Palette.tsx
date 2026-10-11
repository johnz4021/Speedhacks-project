// ⌘K: find a domain, cell, group, file, symbol, route, decision or turn. Jumping opens the containers on the way,
// focuses and selects the target, and flies the camera there.
import { useEffect, useMemo, useRef, useState } from 'react';
import { fileOf, type ContextGraph, type UIState } from '@harness/core/view';
import { useView } from '../derive';
import { useStore } from '../store';
import { jump } from './nav';
import { useScene } from './pipeline';
import { selectionFor } from './select';
import { useV2 } from './store';

type Item = { key: string; kind: string; label: string; sub: string; hay: string; rank: number; run: () => void };

const RANK: Record<string, number> = { domain: 0, cell: 1, group: 2, file: 3, route: 4, symbol: 5, decision: 6, turn: 7 };
const KIND_LABEL: Record<string, string> = { domain: 'Domain', cell: 'Cell', group: 'Folder', file: 'File', route: 'Route', symbol: 'Symbol', decision: 'Decision', turn: 'Turn' };

function isMember(g: ContextGraph, id: string) {
  const n = g.nodes[id]!;
  const p = n.parent ? g.nodes[n.parent] : undefined;
  return (n.symbol?.kind === 'property' || n.symbol?.kind === 'method') && p?.symbol?.kind === 'type';
}

function itemsOf(graph: ContextGraph, ui: UIState, go: (id: string) => void, setTurn: (id: string | null) => void): Item[] {
  const out: Item[] = [];
  const domainName = (d?: string) => (d && graph.nodes[`domain:${d}`]?.label) || d || '';
  for (const n of Object.values(graph.nodes)) {
    let kind: string = n.kind;
    let sub = '';
    if (n.kind === 'domain') sub = 'Domain';
    else if (n.kind === 'cell') sub = `${domainName(n.domain)} cell`;
    else if (n.kind === 'group') sub = `${domainName(n.domain)} · ${n.path ?? ''}`;
    else if (n.kind === 'file') sub = n.path ?? n.id;
    else if (n.kind === 'route') sub = fileOf(n.parent ?? '') ?? '';
    else if (n.kind === 'symbol') { if (isMember(graph, n.id)) continue; sub = fileOf(n.id) ?? ''; }
    else continue;
    const label = n.kind === 'cell' ? `${domainName(n.domain)} · ${n.label}` : n.kind === 'symbol' ? n.id.slice(n.id.indexOf('#') + 1) : n.label;
    if (n.kind === 'group' && n.id === 'group:vendors') continue;
    kind = n.kind;
    out.push({ key: n.id, kind, label, sub, hay: `${label} ${sub}`.toLowerCase(), rank: RANK[kind] ?? 9, run: () => go(n.id) });
  }
  for (const d of ui.decisions) {
    const target = d.paths.find((p) => graph.nodes[p]);
    out.push({ key: `dec:${d.id}`, kind: 'decision', label: `${d.id} ${d.title}`, sub: d.paths.join(', ') || d.invariant, hay: `${d.id} ${d.title} ${d.invariant} ${d.paths.join(' ')}`.toLowerCase(), rank: RANK.decision!, run: () => (target ? go(target) : undefined) });
  }
  ui.turns.forEach((t, i) => {
    out.push({ key: `turn:${t.id}`, kind: 'turn', label: `Turn ${i + 1}`, sub: t.prompt, hay: `turn ${i + 1} ${t.prompt}`.toLowerCase(), rank: RANK.turn!, run: () => setTurn(i === ui.turns.length - 1 ? null : t.id) });
  });
  return out;
}

function search(items: Item[], q: string): Item[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return items.filter((i) => i.kind === 'domain' || i.kind === 'turn' || i.kind === 'decision').sort((a, b) => a.rank - b.rank);
  const scored: { i: Item; s: number }[] = [];
  for (const i of items) {
    if (!terms.every((t) => i.hay.includes(t))) continue;
    const l = i.label.toLowerCase();
    const s = (l === terms[0] ? 0 : l.startsWith(terms[0]!) ? 10 : l.includes(terms[0]!) ? 20 : 40) + i.rank * 2 + Math.min(20, l.length / 4);
    scored.push({ i, s });
  }
  return scored.sort((a, b) => a.s - b.s || a.i.label.localeCompare(b.i.label)).slice(0, 40).map((x) => x.i);
}

export function Palette() {
  const open = useV2((s) => s.palette);
  if (!open) return null;
  return <PaletteBody />;
}

function PaletteBody() {
  const scene = useScene();
  const ui = useView().ui;
  const select = useStore((s) => s.select);
  const setTurn = useStore((s) => s.setTurn);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const close = () => useV2.getState().setPalette(false);

  const items = useMemo(() => {
    if (!scene) return [];
    const go = (id: string) => {
      const st = useV2.getState();
      const next = jump(scene.graph, { open: st.open, focus: st.focus }, id);
      st.go(next, next.focus);
      const n = next.focus ? scene.graph.nodes[next.focus] : undefined;
      if (n) select(selectionFor(n));
    };
    return itemsOf(scene.graph, ui, go, setTurn);
  }, [scene, ui, select, setTurn]);
  const results = useMemo(() => search(items, q), [items, q]);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => setAt(0), [q]);

  const choose = (i: Item | undefined) => {
    if (!i) return;
    close();
    i.run();
  };

  return (
    <div className="v2-palette-scrim" onMouseDown={close}>
      <div className="v2-palette" role="dialog" aria-label="Find on the map" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          className="v2-palette-input"
          value={q}
          placeholder="Find a domain, file, symbol, route, decision or turn"
          aria-label="Search the map"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); close(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setAt((a) => Math.min(results.length - 1, a + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((a) => Math.max(0, a - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); choose(results[at]); }
          }}
        />
        <ul className="v2-palette-list" role="listbox">
          {results.length === 0 && <li className="v2-palette-none">Nothing matches “{q}”.</li>}
          {results.map((r, i) => (
            <li key={r.key} role="option" aria-selected={i === at} className={i === at ? 'is-active' : ''} onMouseEnter={() => setAt(i)} onClick={() => choose(r)}>
              <span className={`v2-palette-kind k-${r.kind}`}>{KIND_LABEL[r.kind] ?? r.kind}</span>
              <span className="v2-palette-label">{r.label}</span>
              <span className="v2-palette-sub">{r.sub}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
