import { useView } from '../derive';
import { useStore } from '../store';

export function Scrubber() {
  const v = useView();
  const total = useStore((s) => s.events.length);
  const setReplay = useStore((s) => s.setReplay);
  const setTurn = useStore((s) => s.setTurn);
  if (!total) return <div className="scrubber" />;
  const pct = (i: number) => `${(i / total) * 100}%`;
  return (
    <div className={`scrubber ${v.live ? '' : 'is-replaying'}`}>
      <span className="scrub-label">{v.live ? 'Live' : `Replay ${v.upTo} of ${total}`}</span>
      <div className="scrub-track">
        <div className="scrub-ticks" aria-hidden="true">
          {v.turnStarts.map((i, n) => (
            <span key={i} className="scrub-tick" style={{ left: pct(i) }}>
              <span className="scrub-tick-label">Turn {n + 1}</span>
            </span>
          ))}
        </div>
        <input
          type="range"
          min={0}
          max={total}
          value={v.upTo}
          aria-label="Replay the event log"
          onChange={(e) => {
            const i = Number(e.target.value);
            setTurn(null);
            setReplay(i >= total ? null : i);
          }}
        />
      </div>
      <button className={`btn btn-live ${v.live ? 'is-live' : ''}`} disabled={v.live} onClick={() => setReplay(null)}>
        Live
      </button>
    </div>
  );
}
