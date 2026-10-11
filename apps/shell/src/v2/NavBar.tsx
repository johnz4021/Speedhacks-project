// Where you are and how to move: back/forward (⌘[ ⌘]), breadcrumbs (System › Domain › Cell › Group › File),
// the ⌘K search and the minimap toggle.
import { useStore } from '../store';
import { ancestors, jump } from './nav';
import { useScene } from './pipeline';
import { useV2 } from './store';

const CRUMB = new Set(['domain', 'cell', 'group', 'file', 'unassigned']);
const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const mod = mac ? '⌘' : 'Ctrl+';

export function NavBar() {
  const scene = useScene();
  const open = useV2((s) => s.open);
  const focus = useV2((s) => s.focus);
  const back = useV2((s) => s.back.length);
  const forward = useV2((s) => s.forward.length);
  const minimap = useV2((s) => s.minimap);
  const st = useV2.getState();
  const select = useStore((s) => s.select);
  const graph = scene?.graph;

  const at = focus && graph?.nodes[focus] ? focus : scene?.open.at(-1) ?? null;
  const path = graph && at ? ancestors(graph, at).filter((id) => CRUMB.has(graph.nodes[id]!.kind)) : [];
  const goTo = (id: string | null) => {
    if (!graph) return;
    select(null);
    if (!id) return st.go({ open: [], focus: null });
    const next = jump(graph, { open, focus }, id);
    st.go(next, next.focus);
  };

  return (
    <nav className="v2-nav" aria-label="Map navigation">
      <span className="v2-nav-hist">
        <button type="button" className="v2-nav-btn" disabled={!back} onClick={st.goBack} title={`Back (${mod}[)`} aria-label="Back">‹</button>
        <button type="button" className="v2-nav-btn" disabled={!forward} onClick={st.goForward} title={`Forward (${mod}])`} aria-label="Forward">›</button>
      </span>
      <ol className="v2-crumbs">
        <li>{path.length ? <button type="button" onClick={() => goTo(null)}>System</button> : <span aria-current="location">System</span>}</li>
        {path.map((id, i) => {
          const n = graph!.nodes[id]!;
          const last = i === path.length - 1;
          return (
            <li key={id}>
              {last ? <span aria-current="location">{n.label}</span> : <button type="button" onClick={() => goTo(id)}>{n.label}</button>}
            </li>
          );
        })}
      </ol>
      <span className="v2-nav-tools">
        <button type="button" className="v2-nav-search" onClick={() => st.setPalette(true)} title="Find a domain, cell, file, symbol, route, decision or turn">
          Find <kbd>{mod}K</kbd>
        </button>
        <button type="button" className={`v2-nav-btn ${minimap ? 'is-on' : ''}`} onClick={st.toggleMinimap} aria-pressed={minimap} title="Minimap (m)">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="1.5" y="3" width="13" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" /><rect x="8" y="7.5" width="5" height="4" fill="currentColor" /></svg>
        </button>
      </span>
    </nav>
  );
}
