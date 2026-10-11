import { useMemo } from 'react';
import { cellKey, type CellView } from '@harness/core/view';
import { basename, stem, useView } from '../derive';
import { useFlash, useSize, useTween } from '../hooks';
import { edgeSegments, gridLayout, routeEdges, type GridLayout, type Rect } from '../layout';
import { useStore } from '../store';

export function MapGrid() {
  const v = useView();
  const [ref, size] = useSize<HTMLDivElement>();
  const select = useStore((s) => s.select);
  const map = v.ui.map;
  const withUnassigned = v.unassigned.length > 0 || (v.turn?.unassigned.length ?? 0) > 0;

  const L = useMemo(() => (map && size.w > 0 ? gridLayout(map, size, withUnassigned) : null), [map, size, withUnassigned]);
  const routed = useMemo(() => (L ? routeEdges(L, edgeSegments(v.ui, v.turn, v.edges)) : []), [L, v.ui, v.turn, v.edges]);

  return (
    <div className="grid-wrap" ref={ref} onClick={() => select(null)}>
      {!map && <GridEmpty />}
      {map && L && (
        <div className="grid" style={{ width: L.width, height: L.height }}>
          {L.cols.map((c) => (
            <div key={c.id} className={`col-head ${c.id === '__unassigned' ? 'is-unassigned' : ''} ${c.index >= L.cols.length - 2 ? 'is-end' : ''}`} style={{ left: c.x, width: L.colW, height: L.headerH }} tabIndex={0}>
              <span className="col-name">{c.name}</span>
              <span className="col-purpose" role="tooltip">{c.purpose}</span>
            </div>
          ))}
          {L.rows.map((r) => (
            <div key={r.id} className="row-label" style={{ top: r.y, height: L.rowH, width: L.labelW }}>{r.name}</div>
          ))}
          {Object.entries(L.cells).map(([k, rect]) => (
            <Cell key={k} k={k} rect={rect} view={v.cells[k]} />
          ))}
          {L.unassigned && <UnassignedColumn rect={L.unassigned} />}
          <EdgeLayer L={L} routed={routed} />
          <AgentCursor L={L} />
        </div>
      )}
    </div>
  );
}

function GridEmpty() {
  const conn = useStore((s) => s.conn);
  return (
    <div className="grid-empty">
      <p className="grid-empty-title">{conn === 'down' ? 'Waiting for the Interpretability server' : 'Reading the repo'}</p>
      <p>{conn === 'down' ? 'Start it with HARNESS_REPO=<path> npm run dev. This page reconnects on its own.' : 'The map appears once domains.yaml is loaded or proposed.'}</p>
    </div>
  );
}

function Cell({ k, rect, view }: { k: string; rect: Rect; view: CellView | undefined }) {
  const v = useView();
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const [domain, layer] = k.split('/') as [string, string];
  const files = v.cellFiles[k] ?? [];
  const tables = v.ui.map?.domains.find((d) => d.id === domain)?.cells[layer]?.tables ?? [];
  const flash = useFlash(files.length);
  const added = useTween(view?.added ?? 0);
  const removed = useTween(view?.removed ?? 0);
  const selected = selection && 'cell' in selection && selection.cell === k;

  const cls = ['cell'];
  if (view?.looked && !view.edited) cls.push('is-looked');
  if (view?.edited) cls.push(view.unplanned ? 'is-unplanned' : 'is-edited');
  if (view?.ghost) cls.push('is-ghost');
  if (view?.violation) cls.push('is-violation');
  if (view?.violation === 'new') cls.push('is-new-violation');
  if (selected) cls.push('is-selected');
  if (flash) cls.push('is-flash');

  const maxLines = Math.max(1, Math.floor((rect.h - 42 - tables.length * 21) / 18));
  // The files that matter this turn come first: rule-crossing, then edited, then the rest.
  const edited = v.turn?.edited[k]?.files ?? [];
  const hot = new Set([...(view?.violationFiles ?? []), ...(view?.newViolationFiles ?? [])]);
  const rank = (f: string) => (hot.has(f) ? 0 : edited.includes(f) ? 1 : 2);
  const ordered = [...files].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const names = ordered.map(stem);
  let shown = names.length > maxLines ? names.slice(0, maxLines - 1) : names;
  if (!shown.length && names.length) shown = names.slice(0, 1); // one line only: "name +N more" below fits as a suffix
  const more = names.length - shown.length;
  const label = `${v.ui.map?.domains.find((d) => d.id === domain)?.name ?? domain}, ${layer}`;

  return (
    <button
      type="button"
      className={cls.join(' ')}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        select(selected ? null : { cell: k });
      }}
    >
      <span className="cell-files">
        {shown.map((n, i) => (
          <span key={i} className={`cell-file ${hot.has(ordered[i]!) ? 'is-hot' : ''}`}>
            {n}
            {more > 0 && maxLines === 1 && <span className="cell-more"> +{more}</span>}
          </span>
        ))}
        {more > 0 && maxLines > 1 && <span className="cell-more">+{more} more</span>}
      </span>
      {tables.length > 0 && (
        <span className="cell-tables">{tables.map((t) => <span key={t} className="cell-table">{t}</span>)}</span>
      )}
      <span className="cell-foot">
        <span className="cell-count">{files.length} {files.length === 1 ? 'file' : 'files'}</span>
        {view?.edited && (
          <span className="cell-diff">
            <span className="plus">+{added}</span> <span className="minus">−{removed}</span>
          </span>
        )}
      </span>
      {view?.ghost && (
        <span className="cell-steps" aria-label={`Planned in step ${view.ghost.join(', ')}`}>
          {view.ghost.map((n) => <span key={n} className="step-dot">{n}</span>)}
        </span>
      )}
      {view?.violation && view.violationFiles.length > 0 && (
        <span className="badge-existing" title={view.violationFiles.join('\n')}>
          {view.violationFiles.length}
        </span>
      )}
      {view?.violation === 'new' && (
        <span className="badge-new" title={view.newViolationFiles.join('\n')}>
          <strong>new</strong> {view.newViolationFiles.map(basename).join(', ')}
        </span>
      )}
    </button>
  );
}

function UnassignedColumn({ rect }: { rect: Rect }) {
  const v = useView();
  const select = useStore((s) => s.select);
  const edited = new Set(v.turn?.unassigned ?? []);
  const files = [...new Set([...v.unassigned, ...edited])].sort();
  return (
    <button
      type="button"
      className={`cell cell-unassigned ${edited.size ? 'is-unplanned' : ''}`}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      onClick={(e) => {
        e.stopPropagation();
        select({ unassigned: true });
      }}
    >
      <span className="cell-files">
        {files.slice(0, 14).map((f) => <span key={f} className="cell-file" title={f}>{basename(f)}</span>)}
        {files.length > 14 && <span className="cell-more">+{files.length - 14} more</span>}
      </span>
      <span className="cell-foot"><span className="cell-count">{files.length} {files.length === 1 ? 'file' : 'files'}</span></span>
    </button>
  );
}

function EdgeLayer({ L, routed }: { L: GridLayout; routed: ReturnType<typeof routeEdges> }) {
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const selCell = selection && 'cell' in selection ? selection.cell : null;
  const selPair = selection && 'pair' in selection ? selection.pair : null;
  return (
    <svg className="edges" width={L.width} height={L.height} aria-hidden="false">
      <defs>
        {(['existing', 'new', 'ghost', 'violation'] as const).map((k) => (
          <marker key={k} id={`arrow-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 z" className={`arrowhead arrowhead-${k}`} />
          </marker>
        ))}
      </defs>
      {routed.map((r) => {
        const kind = r.violation ? 'violation' : r.state;
        const focused = selPair === r.pair || (selCell !== null && (r.src === selCell || r.dst === selCell));
        const dimmed = (selPair !== null || selCell !== null) && !focused;
        return (
          <g
            key={r.key}
            className={`edge edge-${r.state} ${r.violation ? 'edge-violation' : ''} ${focused ? 'is-focused' : ''} ${dimmed ? 'is-dimmed' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              select({ edge: r.edgeKey, pair: r.pair });
            }}
          >
            <title>{`${r.files.map((f) => `${f.from} → ${f.to}`).join('\n')}`}</title>
            <path className="edge-hit" d={r.d} />
            <path
              className="edge-line"
              d={r.d}
              markerEnd={`url(#arrow-${kind})`}
              {...(r.state === 'new' ? { pathLength: 1 } : {})}
            />
          </g>
        );
      })}
    </svg>
  );
}

function AgentCursor({ L }: { L: GridLayout }) {
  const v = useView();
  const c = v.ui.cursor;
  const rect = c?.cell ? L.cells[cellKey(c.cell)] : undefined;
  if (!c || !rect) return null;
  // Near the right edge the label hangs to the left of the avatar instead.
  const flip = rect.x + 280 > L.width;
  const x = flip ? rect.x + rect.w - 34 : rect.x + 10;
  return (
    <div className={`cursor ${flip ? 'is-flipped' : ''}`} style={{ transform: `translate(${x}px, ${rect.y - 13}px)` }} aria-live="polite">
      <span className="cursor-avatar" aria-hidden="true">C</span>
      <span className="cursor-label">
        Claude · {c.verb} <code>{basename(c.path)}</code>
      </span>
    </div>
  );
}
