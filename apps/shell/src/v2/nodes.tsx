// Custom React Flow nodes. Each is memoized and reads only its own slice of the projection from the v2 store, plus
// the zoom bucket, so a zoom re-renders a node only when its level of detail changes.
import { memo } from 'react';
import { useStore as useFlow, type NodeProps } from '@xyflow/react';
import type { Rollup, VisibleNode } from '@harness/core/view';
import { useTween } from '../hooks';
import { useStore } from '../store';
import { selectedNode } from './select';
import { useV2 } from './store';

export type Lod = 'far' | 'mid' | 'near';
export const lodOf = (zoom: number): Lod => (zoom < 0.36 ? 'far' : zoom < 0.72 ? 'mid' : 'near');
export const useLod = () => useFlow((s) => lodOf(s.transform[2]));

const base = (p: string) => p.split('/').pop() ?? p;

function stateClasses(r: Rollup, ghost: boolean) {
  const c: string[] = [];
  if (r.looked && !r.edited) c.push('is-looked');
  if (r.edited) c.push(r.unplanned ? 'is-unplanned' : 'is-edited');
  if (ghost) c.push('is-ghost');
  if (r.violation === 'existing') c.push('is-violation');
  if (r.violation === 'new') c.push('is-new-violation');
  if (r.cursor) c.push('is-cursor');
  return c.join(' ');
}

function useMarks(id: string) {
  const focus = useV2((s) => s.focus === id);
  const selected = useStore((s) => selectedNode(s.selection) === id);
  return `${focus ? 'is-focus' : ''} ${selected ? 'is-selected' : ''}`;
}

function Steps({ steps }: { steps: number[] }) {
  if (!steps.length) return null;
  return (
    <span className="v2-steps" aria-label={`Planned in step ${steps.join(', ')}`}>
      {steps.map((n) => <span key={n} className="v2-step">{n}</span>)}
    </span>
  );
}

/** +/− badge, ticking up as edits land. */
function Diff({ r }: { r: Rollup }) {
  const added = useTween(r.added);
  const removed = useTween(r.removed);
  if (!r.edited) return null;
  return (
    <span className="v2-diff">
      <span className="plus">+{added}</span>
      <span className="minus">−{removed}</span>
    </span>
  );
}

/** Existing crossings: a ring badge with the rule ids and file count. New crossings: a solid badge naming the file. */
function Violations({ r, compact = false }: { r: Rollup; compact?: boolean }) {
  if (!r.violation) return null;
  const existing = r.violationFiles.filter((f) => !r.newViolationFiles.includes(f));
  return (
    <span className="v2-vmarks">
      {r.newViolationFiles.length > 0 && (
        <span className="v2-vmark is-new" title={r.newViolationFiles.join('\n')}>
          <b>new</b>{!compact && <> {r.newViolationFiles.map(base).join(', ')}</>}
        </span>
      )}
      {(existing.length > 0 || (!r.newViolationFiles.length && r.rules.length > 0)) && (
        <span className="v2-vmark" title={[...r.rules, ...existing].join('\n')}>
          {compact ? existing.length || r.rules.length : `${r.rules.join(' ')}${existing.length > 1 ? ` · ${existing.length}` : ''}`}
        </span>
      )}
    </span>
  );
}

const useNode = (id: string) => useV2((s) => s.nodes[id]) as VisibleNode | undefined;

export const FileNode = memo(function FileNode({ id }: NodeProps) {
  const n = useNode(id);
  const lod = useLod();
  const marks = useMarks(id);
  const syms = useV2((s) => s.symbols[id] ?? 0);
  if (!n) return null;
  const r = n.rollup;
  const ghost = r.ghostSteps.length > 0;
  return (
    <div className={`v2-file ${stateClasses(r, ghost)} ${r.plannedNew ? 'is-planned-new' : ''} lod-${lod} ${marks}`} title={n.path ?? n.id}>
      {lod !== 'far' && <span className="v2-file-name">{n.label}</span>}
      {lod !== 'far' && (
        <span className="v2-file-meta">
          {syms > 0 && <span className="v2-syms" title={`${syms} symbol${syms === 1 ? '' : 's'} changed`}>ƒ{syms}</span>}
          <Diff r={r} />
        </span>
      )}
      <Steps steps={r.ghostSteps} />
      {lod !== 'far' && <Violations r={r} />}
    </div>
  );
});

export const CellNode = memo(function CellNode({ id }: NodeProps) {
  const n = useNode(id);
  const lod = useLod();
  const marks = useMarks(id);
  const hot = useV2((s) => s.hot[id]);
  if (!n) return null;
  const r = n.rollup;
  const ghost = r.ghostSteps.length > 0 && !r.edited;
  const names = hot ?? n.preview;
  const room = lod === 'near' ? 4 : 2;
  const shown = names.slice(0, room);
  const more = r.leaves - shown.length;
  return (
    <div className={`v2-cell ${stateClasses(r, ghost)} lod-${lod} ${marks}`}>
      {lod === 'far' ? (
        <span className="v2-cell-count is-big">{r.leaves}</span>
      ) : (
        <>
          <span className="v2-cell-files">
            {shown.map((f, i) => <span key={`${f}${i}`} className="v2-cell-file">{f.replace(/\.[cm]?[jt]sx?$/, "")}</span>)}
            {more > 0 && <span className="v2-cell-more">+{more} more</span>}
          </span>
          <span className="v2-cell-foot">
            <span className="v2-cell-count">{r.leaves} {r.leaves === 1 ? 'file' : 'files'}</span>
            <Diff r={r} />
          </span>
        </>
      )}
      {ghost && <Steps steps={r.ghostSteps} />}
      <Violations r={r} compact={lod === 'far'} />
    </div>
  );
});

/** A compressed column's cell: no text, only the state it carries (fill, ghost dash, rule marks, count). */
export const SpineNode = memo(function SpineNode({ id }: NodeProps) {
  const n = useNode(id);
  const marks = useMarks(id);
  if (!n) return null;
  const r = n.rollup;
  const ghost = r.ghostSteps.length > 0 && !r.edited;
  return (
    <div className={`v2-spine ${stateClasses(r, ghost)} ${marks}`} title={`${n.label}: ${r.leaves} files`}>
      <span className="v2-spine-count">{r.leaves}</span>
      {ghost && <Steps steps={r.ghostSteps} />}
      <Violations r={r} compact />
    </div>
  );
});

export const ContainerNode = memo(function ContainerNode({ id }: NodeProps) {
  const n = useNode(id);
  const lod = useLod();
  const marks = useMarks(id);
  if (!n) return null;
  const r = n.rollup;
  return (
    <div className={`v2-container is-${n.kind} ${r.violation ? `has-${r.violation}` : ''} ${r.edited ? 'has-edits' : ''} lod-${lod} ${marks}`}>
      <span className="v2-container-head">
        <span className="v2-container-name">{n.kind === 'group' ? n.label : n.label}</span>
        <span className="v2-container-count">{r.leaves} {r.leaves === 1 ? 'file' : 'files'}</span>
        <Diff r={r} />
      </span>
    </div>
  );
});

/** A collapsed directory or component inside an open cell. */
export const GroupNode = memo(function GroupNode({ id }: NodeProps) {
  const n = useNode(id);
  const lod = useLod();
  const marks = useMarks(id);
  if (!n) return null;
  const r = n.rollup;
  const ghost = r.ghostSteps.length > 0 && !r.edited;
  return (
    <div className={`v2-group ${stateClasses(r, ghost)} lod-${lod} ${marks}`} title={n.preview.join(', ')}>
      {lod !== 'far' && <span className="v2-group-name">{n.label}</span>}
      {lod !== 'far' && <span className="v2-group-count">{r.leaves} files <Diff r={r} /></span>}
      {ghost && <Steps steps={r.ghostSteps} />}
      {lod !== 'far' && <Violations r={r} compact />}
    </div>
  );
});

/** Tables, vendors and routes inside an open cell. */
export const ChipNode = memo(function ChipNode({ id }: NodeProps) {
  const n = useNode(id);
  const lod = useLod();
  const marks = useMarks(id);
  if (!n) return null;
  return (
    <div className={`v2-chip is-${n.kind} ${stateClasses(n.rollup, false)} ${marks}`}>
      {lod !== 'far' && <><span className="v2-chip-kind">{n.kind === 'table' ? 'table' : n.kind}</span><span className="v2-chip-name">{n.label}</span></>}
    </div>
  );
});

/** The open column: the next step down the depth lightness ramp. */
export const BandNode = memo(function BandNode() {
  return <div className="v2-band" />;
});

export const nodeTypes = { file: FileNode, cell: CellNode, spine: SpineNode, container: ContainerNode, group: GroupNode, chip: ChipNode, band: BandNode };
