// Custom React Flow nodes. Each is memoized and reads only its own slice of the projection from the v2 store,
// plus the zoom bucket, so a zoom re-renders a node only when its level of detail changes.
import { memo } from 'react';
import { useStore as useFlow, type NodeProps } from '@xyflow/react';
import type { Rollup, VisibleNode } from '@harness/core/view';
import { useV2 } from './store';

export type Lod = 'far' | 'mid' | 'near';
export const lodOf = (zoom: number): Lod => (zoom < 0.4 ? 'far' : zoom < 0.72 ? 'mid' : 'near');
export const useLod = () => useFlow((s) => lodOf(s.transform[2]));

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

function Steps({ steps }: { steps: number[] }) {
  if (!steps.length) return null;
  return (
    <span className="v2-steps" aria-label={`Planned in step ${steps.join(', ')}`}>
      {steps.map((n) => <span key={n} className="v2-step">{n}</span>)}
    </span>
  );
}

function Diff({ r }: { r: Rollup }) {
  if (!r.edited) return null;
  return (
    <span className="v2-diff">
      <span className="plus">+{r.added}</span>
      <span className="minus">−{r.removed}</span>
    </span>
  );
}

/** Which rule a node crosses, and whether the crossing is new this turn. */
function ViolationMark({ id, r }: { id: string; r: Rollup }) {
  const rules = useV2((s) => s.rules[id]);
  if (!r.violation) return null;
  const files = [...r.newViolationFiles, ...r.violationFiles].join('\n');
  return (
    <span className={`v2-vmark ${r.violation === 'new' ? 'is-new' : ''}`} title={files}>
      {r.violation === 'new' && <b>new</b>}
      {(rules ?? []).join(' ')}
    </span>
  );
}

const useNode = (id: string) => useV2((s) => s.nodes[id]) as VisibleNode | undefined;

export const FileNode = memo(function FileNode({ id }: NodeProps) {
  const n = useNode(id);
  const lod = useLod();
  const isNew = useV2((s) => !!s.planned[id]);
  if (!n) return null;
  const r = n.rollup;
  const ghost = r.ghostSteps.length > 0;
  return (
    <div className={`v2-file ${stateClasses(r, ghost)} ${isNew ? 'is-planned-new' : ''} lod-${lod}`}>
      {lod !== 'far' && <span className="v2-file-name">{n.label}</span>}
      {lod !== 'far' && (
        <span className="v2-file-meta">
          <Diff r={r} />
          <Steps steps={r.ghostSteps} />
        </span>
      )}
      {lod !== 'far' && <ViolationMark id={id} r={r} />}
    </div>
  );
});

export const CellNode = memo(function CellNode({ id }: NodeProps) {
  const n = useNode(id);
  const lod = useLod();
  const preview = useV2((s) => s.preview[id]);
  if (!n) return null;
  const r = n.rollup;
  const ghost = r.ghostSteps.length > 0 && !r.edited;
  const names = preview ?? [];
  const shown = names.slice(0, 4);
  return (
    <div className={`v2-cell ${stateClasses(r, ghost)} lod-${lod}`}>
      {lod === 'far' ? (
        <span className="v2-cell-count is-big">{r.leaves}</span>
      ) : (
        <>
          <span className="v2-cell-files">
            {(lod === 'near' ? shown : shown.slice(0, 2)).map((f) => <span key={f} className="v2-cell-file">{f}</span>)}
            {names.length > (lod === 'near' ? 4 : 2) && <span className="v2-cell-more">+{names.length - (lod === 'near' ? 4 : 2)} more</span>}
          </span>
          <span className="v2-cell-foot">
            <span className="v2-cell-count">{r.leaves} {r.leaves === 1 ? 'file' : 'files'}</span>
            <Diff r={r} />
          </span>
        </>
      )}
      {ghost && <Steps steps={r.ghostSteps} />}
      <ViolationMark id={id} r={r} />
    </div>
  );
});

/** A compressed column's cell: no text, only the state it carries (fill, ghost dash, rule marks, count). */
export const SpineNode = memo(function SpineNode({ id }: NodeProps) {
  const n = useNode(id);
  if (!n) return null;
  const r = n.rollup;
  const ghost = r.ghostSteps.length > 0 && !r.edited;
  return (
    <div className={`v2-spine ${stateClasses(r, ghost)}`} title={`${n.label}: ${r.leaves} files`}>
      <span className="v2-spine-count">{r.leaves}</span>
      {ghost && <Steps steps={r.ghostSteps} />}
      <ViolationMark id={id} r={r} />
    </div>
  );
});

export const ContainerNode = memo(function ContainerNode({ id }: NodeProps) {
  const n = useNode(id);
  const lod = useLod();
  if (!n) return null;
  const r = n.rollup;
  return (
    <div className={`v2-container ${r.violation ? `has-${r.violation}` : ''} ${r.edited ? 'has-edits' : ''} lod-${lod}`}>
      <span className="v2-container-head">
        <span className="v2-container-name">{n.label}</span>
        <span className="v2-container-count">{r.leaves} {r.leaves === 1 ? 'file' : 'files'}</span>
        <Diff r={r} />
      </span>
    </div>
  );
});

/** The expanded domain's column: the next step down the depth lightness ramp. */
export const BandNode = memo(function BandNode({ id }: NodeProps) {
  const n = useNode(id);
  if (!n) return null;
  return <div className="v2-band"><span className="v2-band-name">{n.label}</span></div>;
});

export const nodeTypes = { file: FileNode, cell: CellNode, spine: SpineNode, container: ContainerNode, band: BandNode };
