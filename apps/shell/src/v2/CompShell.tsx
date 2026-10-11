// The v2 chrome used for the D1 comps (`&comp=1`): turn rail, breadcrumbs, ledger, legend around the v2 map.
// Everything shown is derived from the event log (useView) plus v2 view state; counts only, never minutes.
import { domainId } from '@harness/core/view';
import { useView } from '../derive';
import { useStore } from '../store';
import MapV2 from './MapV2';
import { useV2 } from './store';

export default function CompShell() {
  const theme = useV2((s) => s.theme);
  return (
    <div className={`v2-shell theme-${theme}`} data-theme={theme}>
      <TurnRail />
      <header className="v2-top">
        <Breadcrumbs />
        <Ledger />
      </header>
      <main className="v2-stage">
        <MapV2 insets={{ top: theme === 'strata' ? 96 : 66, right: 36, bottom: 30, left: 96 }} />
      </main>
    </div>
  );
}

function Breadcrumbs() {
  const v = useView();
  const expanded = useV2((s) => s.expanded);
  const setExpanded = useV2((s) => s.setExpanded);
  const cursor = useV2((s) => s.cursor);
  const map = v.ui.map;
  const last = expanded.at(-1);
  const dom = last && map?.domains.find((d) => domainId(d.id) === last);
  const cell = dom && v.ui.cursor?.cell?.domain === dom.id ? map?.layers.find((l) => l.id === v.ui.cursor?.cell?.layer) : null;
  const crumbs: { label: string; onClick?: () => void; current?: boolean }[] = [{ label: 'System', onClick: () => setExpanded([]) }];
  if (dom) crumbs.push({ label: dom.name, onClick: () => setExpanded([last!]) });
  if (cell) crumbs.push({ label: cell.name });
  if (cursor && dom && cursor.node === cursor.path) crumbs.push({ label: cursor.path.split('/').pop()! });
  crumbs[crumbs.length - 1]!.current = true;
  return (
    <nav className="v2-crumbs" aria-label="Where you are">
      <ol>
        {crumbs.map((c, i) => (
          <li key={i}>
            {c.onClick && !c.current ? <button type="button" onClick={c.onClick}>{c.label}</button> : <span aria-current={c.current ? 'location' : undefined}>{c.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Ledger() {
  const v = useView();
  const s = v.ledger.session;
  const items = [
    { label: 'Lines changed', value: s.linesChanged },
    { label: 'Cells to review', value: s.cellsToReview },
    { label: 'Forks caught before code', value: s.forksCaughtBeforeCode },
    { label: 'Rejected options blocked', value: s.rejectedOptionsBlocked },
  ];
  return (
    <dl className="v2-ledger" aria-label="Session ledger">
      {items.map((it) => (
        <div key={it.label} className="v2-counter">
          <dd>{it.value.toLocaleString()}</dd>
          <dt>{it.label}</dt>
        </div>
      ))}
    </dl>
  );
}

function TurnRail() {
  const v = useView();
  const repo = useStore((s) => s.repo).replace(/ \(.*\)$/, '');
  const turn = v.turn;
  const block = turn?.gateBlocks.at(-1);
  const editedFiles = new Set(Object.values(turn?.edited ?? {}).flatMap((e) => e.files));
  const cursorPath = v.ui.cursor?.path;
  const unplanned = turn && Object.keys(turn.planned).length
    ? Object.entries(turn.edited).filter(([k]) => !turn.planned[k]).flatMap(([, e]) => e.files)
    : [];
  return (
    <aside className="v2-rail">
      <div className="v2-brand">
        <span className="v2-brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
        <span className="v2-brand-name">Harness</span>
        <span className="v2-brand-repo">{repo || 'scout-agent'}</span>
      </div>
      {turn && (
        <>
          <p className="v2-rail-turn">Turn {v.turnIndex}</p>
          <p className="v2-prompt">{turn.prompt}</p>
          <ol className="v2-plan">
            {turn.steps.map((st) => {
              const done = st.files.length > 0 && st.files.every((f) => editedFiles.has(f));
              const here = !done && !!cursorPath && st.files.includes(cursorPath);
              return (
                <li key={st.n} className={done ? 'is-done' : here ? 'is-here' : 'is-todo'}>
                  <span className="v2-plan-n">{st.n}</span>
                  <span className="v2-plan-text">{st.text}</span>
                </li>
              );
            })}
          </ol>
        </>
      )}
      {block && (
        <section className="v2-note is-red" aria-live="polite">
          <h3>Edit stopped by {block.invariant}</h3>
          <p><code>{block.file.split('/').pop()}</code> would import <code>{block.target?.split('/').slice(-2).join('/')}</code> directly. Model providers are only called through the model gateway.</p>
        </section>
      )}
      {unplanned.length > 0 && (
        <section className="v2-note is-amber">
          <h3>Edited outside the plan</h3>
          <p>{unplanned.map((f) => <code key={f}>{f.split('/').pop()}</code>)}</p>
        </section>
      )}
      <Legend />
    </aside>
  );
}

function Legend() {
  return (
    <ul className="v2-legend" aria-label="Key">
      <li><i className="k-looked" />Read</li>
      <li><i className="k-edited" />Edited</li>
      <li><i className="k-unplanned" />Edited outside the plan</li>
      <li><i className="k-ghost" />Planned</li>
      <li><i className="k-existing" />Crosses a rule</li>
      <li><i className="k-new" />New crossing</li>
    </ul>
  );
}
