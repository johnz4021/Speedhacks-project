import { useEffect, useState, type ReactNode } from 'react';
import { provenance, type DomainMap, type Invariant, type Violation } from '@harness/core/view';
import { api } from '../connection';
import { turnViolations, useView, type View } from '../derive';
import { edgeSegments, globRe, invariantsFor } from '../layout';
import { useStore, type Selection } from '../store';

export function Inspector() {
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const v = useView();
  const [file, setFile] = useState<string | null>(null);

  useEffect(() => setFile(null), [selection]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') select(null);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [select]);

  if (!selection || !v.ui.map) return null;
  return (
    <aside className="inspector" aria-label="Inspector" onClick={(e) => e.stopPropagation()}>
      <button className="inspector-close" aria-label="Close inspector" onClick={() => select(null)}>×</button>
      {file ? (
        <FilePreview path={file} onBack={() => setFile(null)} />
      ) : (
        <Body v={v} sel={selection} map={v.ui.map} openFile={setFile} />
      )}
    </aside>
  );
}

function Body({ v, sel, map, openFile }: { v: View; sel: Selection; map: DomainMap; openFile: (p: string) => void }) {
  if ('unassigned' in sel) {
    const files = [...new Set([...v.unassigned, ...(v.turn?.unassigned ?? [])])].sort();
    return (
      <>
        <h2 className="insp-title">Unassigned</h2>
        <p className="insp-sub">Files that match no cell in domains.yaml. Add their paths to a domain to place them.</p>
        <Section title="Files"><FileList files={files} openFile={openFile} /></Section>
      </>
    );
  }
  if ('cell' in sel) return <CellBody v={v} k={sel.cell} map={map} openFile={openFile} />;
  return <EdgeBody v={v} edge={sel.edge} pair={sel.pair} map={map} openFile={openFile} />;
}

function CellBody({ v, k, map, openFile }: { v: View; k: string; map: DomainMap; openFile: (p: string) => void }) {
  const [domainId, layerId] = k.split('/') as [string, string];
  const domain = map.domains.find((d) => d.id === domainId);
  const layer = map.layers.find((l) => l.id === layerId);
  const cell = domain?.cells[layerId];
  const view = v.cells[k];
  const files = v.cellFiles[k] ?? [];
  const edited = v.turn?.edited[k];
  const planned = v.turn?.planned[k];
  const plannedNew = (planned?.files ?? []).filter((f) => !files.includes(f));
  const tests = v.testFiles[domainId] ?? [];
  const invs = invariantsFor(map, domainId, files);
  const vios = turnViolations(v).filter(({ v: x }) => cellOfFile(v, x.file) === k);
  const prov = provenance(v.ui, { cell: k });

  const state: string[] = [];
  if (view?.edited) state.push(view.unplanned ? 'Edited without being planned' : 'Edited this turn');
  if (view?.ghost) state.push(`Planned in ${stepList(view.ghost)}`);
  if (view?.looked && !view.edited) state.push('Looked at this turn');

  return (
    <>
      <h2 className="insp-title">{domain?.name ?? domainId} <span className="insp-layer">{layer?.name ?? layerId}</span></h2>
      {domain && <p className="insp-sub">{domain.purpose}</p>}
      {state.length > 0 && <p className={`insp-state ${view?.unplanned ? 'is-amber' : ''}`}>{state.join('. ')}{edited ? `: +${edited.added} −${edited.removed}` : ''}</p>}

      {vios.length > 0 && (
        <Section title="Rules crossed">
          {vios.map(({ v: x, source }, i) => <ViolationItem key={i} v={x} source={source} />)}
        </Section>
      )}

      <Section title={`Files (${files.length})`}>
        <FileList files={files} openFile={openFile} marks={(f) => (edited?.created.includes(f) ? 'created' : edited?.files.includes(f) ? 'edited' : null)} />
        {plannedNew.length > 0 && (
          <p className="insp-note">Planned, not created yet: {plannedNew.map((f) => <code key={f}>{f}</code>)}</p>
        )}
      </Section>

      {(cell?.paths?.length || cell?.tables?.length) && (
        <Section title="Defined by">
          {cell?.paths?.map((p) => <code key={p} className="insp-glob">{p}</code>)}
          {cell?.tables?.length ? <p className="insp-note">Owns tables {cell.tables.map((t) => <code key={t}>{t}</code>)}</p> : null}
        </Section>
      )}

      {invs.length > 0 && <Section title="Rules for this domain">{invs.map((i) => <InvariantItem key={i.id} inv={i} />)}</Section>}

      {tests.length > 0 && (
        <Section title={`Tests for ${domain?.name ?? domainId}`}><FileList files={tests} openFile={openFile} /></Section>
      )}

      <Provenance prov={prov} />
    </>
  );
}

function EdgeBody({ v, edge, pair, map, openFile }: { v: View; edge: string; pair: string; map: DomainMap; openFile: (p: string) => void }) {
  const seg = edgeSegments(v.ui, v.turn, v.edges).find((s) => s.edgeKey === edge && s.pair === pair);
  const [from, to] = edge.split('->') as [string, string];
  const name = (id: string) => map.domains.find((d) => d.id === id)?.name ?? id;
  const files = seg?.files ?? [];
  const vios = turnViolations(v).filter(({ v: x }) => files.some((f) => f.from === x.file && (!x.target || x.target === f.to)));
  const invs = map.invariants.filter(
    (i) => (i.kind === 'no_edge' && i.from === from && i.to === to) || (i.kind === 'only_via' && files.some((f) => i.targets.some((t) => globRe(t).test(f.to)))),
  );
  const prov = provenance(v.ui, { edge });
  const turnNo = v.turnIndex;
  const state = seg?.state === 'ghost' ? `Planned in ${stepList(seg.steps)}, not built yet` : seg?.state === 'new' ? `Added in turn ${turnNo}` : 'On the map before this turn';
  const [srcCell, dstCell] = pair.split('=>') as [string, string];
  const layerName = (k: string) => map.layers.find((l) => l.id === k.split('/')[1])?.name ?? '';

  return (
    <>
      <h2 className="insp-title">{name(from)} <span className="insp-arrow">→</span> {name(to)}</h2>
      <p className="insp-sub">{layerName(srcCell)} to {layerName(dstCell)}. Derived from imports; flow down a column is not drawn.</p>
      <p className={`insp-state ${seg?.violation ? 'is-red' : ''}`}>{state}</p>
      {vios.length > 0 && <Section title="Rules crossed">{vios.map(({ v: x, source }, i) => <ViolationItem key={i} v={x} source={source} />)}</Section>}
      <Section title={`Imports (${files.length})`}>
        <ul className="insp-imports">
          {files.map((f, i) => (
            <li key={i}>
              <button className="link" onClick={() => openFile(f.from)}>{f.from}</button>
              <span className="insp-arrow">→</span>
              <button className="link" onClick={() => openFile(f.to)}>{f.to}</button>
            </li>
          ))}
        </ul>
      </Section>
      {invs.length > 0 && <Section title="Rules on this dependency">{invs.map((i) => <InvariantItem key={i.id} inv={i} />)}</Section>}
      <Provenance prov={prov} scope={`${name(from)} → ${name(to)}`} />
    </>
  );
}

function cellOfFile(v: View, file: string): string | null {
  const p = v.ui.files[file];
  if (p?.kind === 'cell') return `${p.domain}/${p.layer}`;
  const planned = v.turn && Object.entries(v.turn.planned).find(([, c]) => c.files.includes(file));
  return planned ? planned[0] : null;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="insp-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function FileList({ files, openFile, marks }: { files: string[]; openFile: (p: string) => void; marks?: (f: string) => string | null }) {
  if (!files.length) return <p className="insp-note">None.</p>;
  return (
    <ul className="insp-files">
      {files.map((f) => {
        const m = marks?.(f);
        return (
          <li key={f}>
            <button className="link" onClick={() => openFile(f)}>{f}</button>
            {m && <span className={`insp-mark mark-${m}`}>{m}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function ViolationItem({ v, source }: { v: Violation; source: 'load' | 'plan' | 'gate' }) {
  const where = source === 'load' ? 'Found on load' : source === 'plan' ? 'In this turn’s plan' : 'Blocked at edit';
  return (
    <div className={`insp-violation ${source === 'load' ? '' : 'is-new'}`}>
      <p className="insp-vio-head"><strong>{v.invariant}</strong> {where}</p>
      <p>{v.reason}</p>
      <code className="insp-glob">{v.detail}</code>
    </div>
  );
}

function InvariantItem({ inv }: { inv: Invariant }) {
  return (
    <div className="insp-inv">
      <p><strong>{inv.id}</strong> {inv.rule}</p>
      {(inv.decisions?.length || inv.exceptions.length) ? (
        <p className="insp-note">
          {inv.decisions?.length ? <>Confirmed by {inv.decisions.join(', ')}. </> : null}
          {inv.exceptions.length ? <>Exceptions: {inv.exceptions.map((e) => <code key={e.path}>{e.path}{e.decision ? ` (${e.decision})` : ''}</code>)}</> : null}
        </p>
      ) : null}
    </div>
  );
}

function Provenance({ prov, scope }: { prov: ReturnType<typeof provenance>; scope?: string }) {
  if (!prov.turns.length && !prov.decisions.length) {
    return <Section title="History"><p className="insp-note">No changes this session.</p></Section>;
  }
  return (
    <Section title="History">
      <ul className="insp-prov">
        {prov.turns.map((t) => {
          const decs = prov.decisions.filter((d) => d.turn === t.id);
          return (
            <li key={t.id}>
              <span>{scope ? `${scope} changed in turn ${t.index}` : `Changed in turn ${t.index}`}{decs.length ? `, under ${decs.map((d) => d.id).join(', ')}` : ''}</span>
              <span className="insp-prov-prompt">{t.prompt}</span>
              {decs.map((d) => (
                <span key={d.id} className="insp-prov-dec">
                  <strong>{d.id}</strong> {d.title}{d.alike ? ' · in Alike' : ''}
                </span>
              ))}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function FilePreview({ path, onBack }: { path: string; onBack: () => void }) {
  const [text, setText] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setText(undefined);
    api.file(path).then((t) => live && setText(t)).catch(() => live && setText(null));
    return () => {
      live = false;
    };
  }, [path]);
  return (
    <>
      <button className="link insp-back" onClick={onBack}>Back</button>
      <h2 className="insp-title insp-path">{path}</h2>
      {text === undefined && <p className="insp-note">Loading…</p>}
      {text === null && <p className="insp-note">Not on disk. It may be planned but not created yet.</p>}
      {typeof text === 'string' && (
        <pre className="insp-code">
          {text.split('\n').map((l, i) => (
            <span key={i} className="code-line"><span className="code-no">{i + 1}</span>{l || ' '}{'\n'}</span>
          ))}
        </pre>
      )}
    </>
  );
}

const stepList = (steps: number[]) =>
  steps.length === 1 ? `step ${steps[0]}` : `steps ${steps.slice(0, -1).join(', ')} and ${steps[steps.length - 1]}`;
