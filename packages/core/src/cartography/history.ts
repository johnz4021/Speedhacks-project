// History units (Harness turns and git commits) that maps are scored and drift is measured against.
import type { UIState } from '../events';
import type { HistoryTurn } from '../contracts/cartography';

/**
 * Harness turns as history units: the files each turn edited (attributed or not), in log order.
 * Turns that only read are skipped; they say nothing about where change lands.
 */
export function historyFromUI(ui: UIState): HistoryTurn[] {
  const out: HistoryTurn[] = [];
  for (const t of ui.turns) {
    const files = Object.entries(t.paths).filter(([, a]) => a.edits > 0).map(([p]) => p).sort();
    if (files.length) out.push({ id: t.id, source: 'turn', files });
  }
  return out;
}

/**
 * Bulk units (initial imports, mass reformatting) say nothing about boundaries and would swamp the means:
 * a unit is bulk when it touches more than 10 known files and more than 30% of them.
 */
export function isBulk(files: readonly string[], known: ReadonlySet<string>): boolean {
  const n = files.filter((f) => known.has(f)).length;
  return n > 10 && n > 0.3 * known.size;
}
