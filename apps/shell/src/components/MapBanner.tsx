import { api } from '../connection';
import { useView } from '../derive';

export function MapBanner() {
  const v = useView();
  if (!v.proposal) return null;
  const placed = Object.values(v.ui.files).filter((p) => p.kind === 'cell').length;
  return (
    <div className="banner" role="region" aria-label="Proposed map">
      <div>
        <p className="banner-title">
          Proposed map: {v.proposal.domains} domains, {v.proposal.rules} rules
        </p>
        <p className="banner-sub">{placed} files placed. Check the columns read like your product, then confirm.</p>
      </div>
      <div className="banner-actions">
        <button className="btn" disabled={!v.live} onClick={() => void api.fallbackMap()}>Use reference map</button>
        <button className="btn btn-primary" disabled={!v.live} onClick={() => void api.confirmMap()}>Confirm</button>
      </div>
    </div>
  );
}
