import { useEffect, useState, type ReactNode } from 'react';
import { provenance, type DomainMap, type ImportEdge, type Invariant, type Violation } from '@harness/core/view';
import { api } from '../connection';
import { turnViolations, useView, type View } from '../derive';
import { edgeSegments, globRe, invariantsFor } from '../layout';
import { useStore, type Selection } from '../store';
import { useV2 } from '../v2/store';

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
  if ('file' in sel) return <FileBody v={v} path={sel.file} map={map} openFile={openFile} />;
  if ('node' in sel) return <NodeBody v={v} id={sel.node} map={map} openFile={openFile} />;
  if ('link' in sel) return <LinkBody v={v} id={sel.link} map={map} openFile={openFile} />;
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

/** What the inspector shows for an edge, from v1's cell-pair segments or a v2 projected edge. */
type EdgeDetail = {
  from: string; // domain ids
  to: string;
  where: string; // "Logic to External"
  state: 'existing' | 'new' | 'ghost';
  gate: boolean; // a ghost the edit gate blocked (never planned)
  violation: boolean;
  steps: number[];
  files: ImportEdge[];
};

function EdgeBody({ v, edge, pair, map, openFile }: { v: View; edge: string; pair: string; map: DomainMap; openFile: (p: string) => void }) {
  const seg = edgeSegments(v.ui, v.turn, v.edges).find((s) => s.edgeKey === edge && s.pair === pair);
  const [from, to] = edge.split('->') as [string, string];
  const [srcCell, dstCell] = pair.split('=>') as [string, string];
  const layerName = (k: string) => map.layers.find((l) => l.id === k.split('/')[1])?.name ?? '';
  const d: EdgeDetail = {
    from, to, where: `${layerName(srcCell)} to ${layerName(dstCell)}`, state: seg?.state ?? 'existing', gate: false,
    violation: !!seg?.violation, steps: seg?.steps ?? [], files: seg?.files ?? [],
  };
  return <EdgeView v={v} d={d} map={map} openFile={openFile} />;
}

/** A v2 edge: the projected edge's leaf edges (imports, calls, writes; planned or gate-blocked imports for ghosts). */
function LinkBody({ v, id, map, openFile }: { v: View; id: string; map: DomainMap; openFile: (p: string) => void }) {
  const e = useV2((s) => s.edges[id]);
  const nodes = useV2((s) => s.nodes);
  if (!e) return <p className="insp-note">This link is not on the map at this point of the log.</p>;
  const a = nodes[e.from];
  const b = nodes[e.to];
  const files: ImportEdge[] = [];
  for (const leaf of e.leafEdges) {
    const [, f, t] = leaf.split('|') as [string, string, string];
    if (!files.some((x) => x.from === f && x.to === t)) files.push({ from: f, to: t });
  }
  const d: EdgeDetail = {
    from: a?.domain ?? e.from, to: b?.domain ?? e.to, where: `${a?.label ?? e.from} to ${b?.label ?? e.to}`,
    state: e.status, gate: e.leafEdges.every((l) => l.startsWith('gate|')), violation: e.violation !== null, steps: e.steps, files,
  };
  return <EdgeView v={v} d={d} map={map} openFile={openFile} kinds={e.kinds} />;
}

function EdgeView({ v, d, map, openFile, kinds }: { v: View; d: EdgeDetail; map: DomainMap; openFile: (p: string) => void; kinds?: string[] }) {
  const { from, to, files } = d;
  const name = (id: string) => map.domains.find((x) => x.id === id)?.name ?? id;
  const vios = turnViolations(v).filter(({ v: x }) => files.some((f) => f.from === x.file && (!x.target || x.target === f.to)));
  const invs = map.invariants.filter(
    (i) => (i.kind === 'no_edge' && i.from === from && i.to === to) || (i.kind === 'only_via' && files.some((f) => i.targets.some((t) => globRe(t).test(f.to)))),
  );
  const prov = provenance(v.ui, { edge: `${from}->${to}` });
  const state = d.state === 'ghost'
    ? d.gate ? 'Blocked at edit: the import was never written' : `Planned in ${stepList(d.steps)}, not built yet`
    : d.state === 'new' ? `Added in turn ${v.turnIndex}` : 'On the map before this turn';
  const imports = !kinds || kinds.every((k) => k === 'imports');
  return (
    <>
      <h2 className="insp-title">{name(from)} <span className="insp-arrow">→</span> {name(to)}</h2>
      <p className="insp-sub">{d.where}. Derived from {imports ? 'imports' : kinds!.join(', ')}; flow down a column is not drawn.</p>
      <p className={`insp-state ${d.violation ? 'is-red' : ''}`}>{state}</p>
      {vios.length > 0 && <Section title="Rules crossed">{vios.map(({ v: x, source }, i) => <ViolationItem key={i} v={x} source={source} />)}</Section>}
      <Section title={`${imports ? 'Imports' : 'Links'} (${files.length})`}>
        <ul className="insp-imports">
          {files.map((f, i) => (
            <li key={i}>
              <button className="link" onClick={() => openFile(f.from.split('#')[0]!)}>{f.from}</button>
              <span className="insp-arrow">→</span>
              <button className="link" onClick={() => openFile(f.to.split('#')[0]!)}>{f.to}</button>
            </li>
          ))}
        </ul>
      </Section>
      {invs.length > 0 && <Section title="Rules on this dependency">{invs.map((i) => <InvariantItem key={i.id} inv={i} />)}</Section>}
      <Provenance prov={prov} scope={`${name(from)} → ${name(to)}`} />
    </>
  );
}

/** One file (v2): where it sits, what the turn did to it, the rules it crosses, its imports and its code. */
function FileBody({ v, path, map, openFile }: { v: View; path: string; map: DomainMap; openFile: (p: string) => void }) {
  const node = useV2((s) => s.nodes[path]);
  const p = v.ui.files[path];
  const pa = v.turn?.paths[path];
  const r = node?.rollup;
  const domain = p && 'domain' in p ? map.domains.find((d) => d.id === p.domain) : undefined;
  const layer = p?.kind === 'cell' ? map.layers.find((l) => l.id === p.layer) : undefined;
  const vios = turnViolations(v).filter(({ v: x }) => x.file === path);
  const out = (v.ui.facts[path]?.imports.map((i) => i.to) ?? []).filter((x) => !x.startsWith('vendor:'));
  const into = Object.values(v.ui.facts).filter((f) => f.imports.some((i) => i.to === path)).map((f) => f.path).sort();
  const sym = pa?.symbols;
  const changed: [string, string][] = sym
    ? [...sym.added.map((s) => ['added', s] as [string, string]), ...sym.sig.map((s) => ['signature', s] as [string, string]), ...sym.body.map((s) => ['body', s] as [string, string]), ...sym.removed.map((s) => ['removed', s] as [string, string])]
    : [];
  const edited = !!(r?.edited || pa?.edits);
  const state: string[] = [];
  if (edited) state.push(r?.unplanned ? 'Edited without being planned' : pa?.created ? 'Created this turn' : 'Edited this turn');
  if (r?.ghostSteps.length) state.push(`Planned in ${stepList(r.ghostSteps)}${r.plannedNew ? ', not created yet' : ''}`);
  if ((r?.looked || pa?.looked) && !edited) state.push('Looked at this turn');
  const prov = p?.kind === 'cell' ? provenance(v.ui, { cell: `${p.domain}/${p.layer}` }) : null;
  return (
    <>
      <h2 className="insp-title insp-path">{path}</h2>
      <p className="insp-sub">{domain ? `${domain.name}${layer ? `, ${layer.name}` : ' tests'}` : p?.kind === 'neutral' ? 'Shared code' : 'Unassigned'}</p>
      {state.length > 0 && <p className={`insp-state ${r?.unplanned ? 'is-amber' : ''}`}>{state.join('. ')}{pa?.edits ? `: +${pa.added} −${pa.removed}` : ''}</p>}
      <button className="btn insp-open" onClick={() => openFile(path)}>Show code</button>
      {vios.length > 0 && <Section title="Rules crossed">{vios.map(({ v: x, source }, i) => <ViolationItem key={i} v={x} source={source} />)}</Section>}
      {changed.length > 0 && (
        <Section title={`Symbols changed (${changed.length})`}>
          <ul className="insp-files">{changed.map(([k, id]) => <li key={`${k}${id}`}><code>{id.slice(id.indexOf('#') + 1)}</code> <span className="insp-mark">{k}</span></li>)}</ul>
        </Section>
      )}
      <Section title={`Imports (${out.length})`}><FileList files={out} openFile={openFile} /></Section>
      <Section title={`Imported by (${into.length})`}><FileList files={into} openFile={openFile} /></Section>
      {prov && <Provenance prov={prov} />}
    </>
  );
}

/** A domain, a folder, or a domain's tests (v2). */
function NodeBody({ v, id, map, openFile }: { v: View; id: string; map: DomainMap; openFile: (p: string) => void }) {
  const node = useV2((s) => s.nodes[id]);
  const domain = map.domains.find((d) => d.id === (node?.domain ?? id.replace(/^domain:/, '')));
  if (id.startsWith('domain:') && domain) {
    const files = Object.entries(v.ui.files).filter(([, p]) => p.kind === 'cell' && p.domain === domain.id).map(([f]) => f);
    const invs = invariantsFor(map, domain.id, files);
    const count = (layer: string) => files.filter((f) => { const p = v.ui.files[f]; return p?.kind === 'cell' && p.layer === layer; }).length;
    return (
      <>
        <h2 className="insp-title">{domain.name}</h2>
        <p className="insp-sub">{domain.purpose}</p>
        <Section title="Cells">
          <ul className="insp-files">
            {map.layers.filter((l) => l.id in domain.cells).map((l) => <li key={l.id}>{l.name} <span className="insp-note">{count(l.id)} files</span></li>)}
          </ul>
        </Section>
        {invs.length > 0 && <Section title="Rules for this domain">{invs.map((i) => <InvariantItem key={i.id} inv={i} />)}</Section>}
      </>
    );
  }
  const prefix = node?.path ? `${node.path}/` : null;
  const files = prefix
    ? Object.keys(v.ui.files).filter((f) => f.startsWith(prefix)).sort()
    : node?.kind === 'tests' && domain ? Object.entries(v.ui.files).filter(([, p]) => p.kind === 'test' && p.domain === domain.id).map(([f]) => f).sort() : [];
  return (
    <>
      <h2 className="insp-title">{node?.label ?? id}</h2>
      {domain && <p className="insp-sub">{domain.name}</p>}
      <Section title={`Files (${files.length})`}><FileList files={files} openFile={openFile} /></Section>
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
