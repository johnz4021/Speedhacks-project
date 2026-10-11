import { useView } from '../derive';
import { useTween } from '../hooks';
import { useStore } from '../store';

export function Header() {
  const repo = useStore((s) => s.repo);
  const conn = useStore((s) => s.conn);
  const name = repo.split('/').filter(Boolean).pop() ?? '';
  return (
    <header className="top">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <span /><span /><span /><span />
        </span>
        <span className="brand-name">Interpretability</span>
        {name && <span className="brand-repo">{name}</span>}
        {conn === 'down' && <span className="conn-down">Server not reachable. Reconnecting…</span>}
      </div>
      <Ledger />
    </header>
  );
}

function Ledger() {
  const v = useView();
  const s = v.ledger.session;
  const t = v.turnLedger;
  const items: { label: string; value: number; turn: number | null }[] = [
    { label: 'Lines changed', value: s.linesChanged, turn: t ? t.linesChanged : null },
    { label: 'Cells to review', value: s.cellsToReview, turn: t?.cellsToReview ?? null },
    { label: 'Forks caught before code', value: s.forksCaughtBeforeCode, turn: t?.forksCaughtBeforeCode ?? null },
    { label: 'Rejected options blocked', value: s.rejectedOptionsBlocked, turn: t?.rejectedOptionsBlocked ?? null },
  ];
  return (
    <dl className="ledger" aria-label="Session ledger">
      {items.map((it) => (
        <Counter key={it.label} {...it} turnIndex={v.turnIndex} />
      ))}
    </dl>
  );
}

function Counter({ label, value, turn, turnIndex }: { label: string; value: number; turn: number | null; turnIndex: number }) {
  const shown = useTween(value, 600);
  return (
    <div className="counter">
      <dd className="counter-value">{shown.toLocaleString()}</dd>
      <dt className="counter-label">{label}</dt>
      {turnIndex > 0 && <dd className="counter-turn">{turn === null ? '–' : turn.toLocaleString()} in turn {turnIndex}</dd>}
    </div>
  );
}
