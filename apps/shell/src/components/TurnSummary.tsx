import { cellKey } from '@harness/core/view';
import { useView, type View } from '../derive';
import { useStore } from '../store';

function phase(v: View): string {
  const t = v.turn;
  if (!t) return '';
  if (t.endedAt !== null) return 'Done';
  if (v.ui.pendingFork?.turn === t.id) return 'Waiting for your choice';
  if (v.ui.awaitingApproval?.turn === t.id) return 'Waiting for approval';
  if (t.approved) return 'Building';
  if (t.steps.length) return 'Planning';
  return 'Exploring';
}

export function TurnSummary() {
  const v = useView();
  const setTurn = useStore((s) => s.setTurn);
  const select = useStore((s) => s.select);
  const selection = useStore((s) => s.selection);
  const turn = v.turn;

  if (!turn) {
    return (
      <section className="summary summary-empty">
        <p>Ask Claude to change something; the map shows what it plans and does.</p>
      </section>
    );
  }

  const findings = v.turnLedger?.findings ?? [];
  const selCell = selection && 'cell' in selection ? selection.cell : null;

  return (
    <section className="summary">
      <div className="summary-turn">
        <div className="turn-tabs" role="tablist" aria-label="Turns">
          {v.ui.turns.map((t, i) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={t.id === turn.id}
              className={`turn-tab ${t.id === turn.id ? 'is-active' : ''}`}
              onClick={() => setTurn(i === v.ui.turns.length - 1 ? null : t.id)}
            >
              Turn {i + 1}
            </button>
          ))}
          <span className="turn-phase">{phase(v)}</span>
        </div>
        <p className="turn-prompt">{turn.prompt}</p>
        {v.steps.total > 0 && (
          <div className="steps" aria-label={`${v.steps.done} of ${v.steps.total} steps`}>
            <span className="steps-bar">
              {Array.from({ length: v.steps.total }, (_, i) => <span key={i} className={`steps-seg ${i < v.steps.done ? 'is-done' : ''}`} />)}
            </span>
            <span className="steps-text">{v.steps.done} of {v.steps.total} steps</span>
          </div>
        )}
      </div>
      <ol className="findings" aria-label="Findings, loudest first">
        {findings.length === 0 && <li className="finding finding-none">Nothing to review yet.</li>}
        {findings.map((f, i) => {
          const res = f.kind === 'invariant' ? resolution(v, f.invariant, f.files[0]) : null;
          return (
          <li key={i}>
            <button
              className={`finding sev-${f.severity} ${res ? 'is-resolved' : ''} ${f.cell && selCell === cellKey(f.cell) ? 'is-selected' : ''}`}
              disabled={!f.cell}
              onClick={(e) => {
                e.stopPropagation();
                if (f.cell) select({ cell: cellKey(f.cell) });
              }}
            >
              <span className="finding-mark" aria-hidden="true" />
              <span className="finding-text">{f.text}</span>
              {f.invariant && <span className="finding-tag">{res ? `${f.invariant}, answered ${res}` : f.invariant}</span>}
            </button>
          </li>
          );
        })}
      </ol>
    </section>
  );
}


/** "A · DR-4" when a fork in this turn answered the violation before code; null while it is open. */
function resolution(v: View, invariant: string | undefined, file: string | undefined): string | null {
  const t = v.turn;
  if (!t || !invariant) return null;
  const fork = t.forks.find((f) => f.answered !== null && f.violations.some((x) => x.invariant === invariant && x.file === file));
  if (!fork) return null;
  const dec = v.ui.decisions.find((d) => d.turn === t.id && d.invariant === invariant && d.paths.includes(file ?? ''));
  return `${fork.option}${dec ? ` (${dec.id})` : ''}`;
}
