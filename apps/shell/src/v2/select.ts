// Map between v2 node ids and the shell's inspector selection (shared with v1, so the inspector stays one component).
import type { VisibleNode } from '@harness/core/view';
import type { Selection } from '../store';

export function selectionFor(n: Pick<VisibleNode, 'id' | 'kind' | 'domain' | 'layer'>): Selection {
  if (n.kind === 'cell') return { cell: `${n.domain}/${n.layer}` };
  if (n.kind === 'file') return { file: n.id };
  if (n.id === 'unassigned') return { unassigned: true };
  return { node: n.id };
}

/** The node a selection points at (edges select no node). */
export function selectedNode(s: Selection | null): string | null {
  if (!s) return null;
  if ('cell' in s) return `cell:${s.cell}`;
  if ('file' in s) return s.file;
  if ('node' in s) return s.node;
  if ('unassigned' in s) return 'unassigned';
  return null;
}

export const selectedEdge = (s: Selection | null): string | null => (s && 'link' in s ? s.link : null);
