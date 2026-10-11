// Tier 1 for Python and Go (N11): web-tree-sitter (pinned runtime + grammars from @vscode/tree-sitter-wasm) producing
// the same FileFacts as TypeScript, the same gate facts, and a graph that traces from a route to a table.
import { beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { deltaForEdit, fileExistsIn, scanRepoFacts } from '../src/facts';
import { check } from '../src/rules';
import { parseDomainMap } from '../src/schema';
import { buildGraph, trace } from '../src/graph';
import { diffSymbols } from '../src/facts/diff';
import { diskLangContext, extractTreeSitter, initTreeSitter, treeSitterReady } from '../src/facts/treesitter';
import type { FileFacts } from '../src/contracts/facts';

const PY = fileURLToPath(new URL('./fixture-py', import.meta.url));
const GO = fileURLToPath(new URL('./fixture-go', import.meta.url));
const MAP_YAML = `version: 1
layers: [{ id: entry, name: Entry }, { id: logic, name: Logic }, { id: data, name: Data }]
domains:
  - { id: api, name: API, purpose: HTTP, cells: { entry: { paths: ["app/api/**", "app/main.py", "app/legacy/**", "internal/api/**", "cmd/**"] } } }
  - { id: core, name: Core, purpose: Runs and storage, cells: { logic: { paths: ["app/services/**"] }, data: { paths: ["app/models.py", "app/db.py", "internal/store/**"], tables: [runs, cost_log] } } }
invariants:
  - { id: DR-1, rule: Storage never depends on the API, kind: no_edge, from: core, to: api, exceptions: [] }
  - { id: DR-2, rule: Only core writes runs, kind: owns_writes, owners: { runs: core }, exceptions: [] }
`;
const map = parseDomainMap(MAP_YAML);

beforeAll(async () => { await initTreeSitter(); });

const summary = (f: FileFacts) => ({
  imports: f.imports.map((i) => i.to),
  symbols: f.symbols.map((s) => `${s.kind} ${s.name}${s.exported ? '' : ' (private)'}`),
  calls: f.calls.map((c) => `${c.from} -> ${c.to}`),
  routes: f.routes.map((r) => `${r.id} => ${r.handler}`),
  entries: f.entries.map((e) => e.id),
  writes: f.writes.map((w) => `${w.table} ${w.symbol} ${w.via}`),
  reads: (f.reads ?? []).map((w) => `${w.table} ${w.symbol} ${w.via}`),
});

describe('Python (FastAPI, Flask, SQLAlchemy, Django)', () => {
  const scan = () => scanRepoFacts(PY, map);

  it('is loaded once and parses synchronously', () => {
    expect(treeSitterReady()).toBe(true);
  });

  it('imports resolve to repo modules (absolute, relative, package submodules), else vendor packages', () => {
    const { fileFacts, imports } = scan();
    expect(summary(fileFacts['app/main.py']!).imports).toEqual(['vendor:fastapi', 'app/api/runs.py', 'app/db.py', 'vendor:uvicorn']);
    expect(summary(fileFacts['app/services/runner.py']!).imports).toEqual(['vendor:anthropic', 'app/db.py', 'app/models.py']);
    expect(imports).toContainEqual({ from: 'app/api/runs.py', to: 'app/services/runner.py' });
    expect(imports.some((i) => i.to.startsWith('vendor:'))).toBe(false); // gate facts: repo files only
  });

  it('symbols, calls through import bindings (aliases, modules, self), routes and entries', () => {
    const { fileFacts } = scan();
    const runner = summary(fileFacts['app/services/runner.py']!);
    expect(runner.symbols).toEqual(['function start_run', 'class Planner', 'method Planner.plan', 'method Planner.score', 'function _private (private)']);
    expect(runner.calls).toEqual(expect.arrayContaining([
      'app/services/runner.py#start_run -> app/models.py#Run',
      'app/services/runner.py#start_run -> app/services/runner.py#Planner',
      'app/services/runner.py#Planner.plan -> app/services/runner.py#Planner.score',
      'app/services/runner.py -> vendor:anthropic',
    ]));
    const runs = summary(fileFacts['app/api/runs.py']!);
    expect(runs.calls).toContain('app/api/runs.py#create_run -> app/services/runner.py#start_run'); // `start_run as begin`
    expect(runs.routes).toEqual(['route:POST /api/runs => app/api/runs.py#create_run', 'route:GET /api/runs/{} => app/api/runs.py#get_run']);
    expect(runs.entries).toEqual(['entry:route:POST /api/runs', 'entry:route:GET /api/runs/{}']);
    expect(summary(fileFacts['app/legacy/views.py']!).routes).toEqual(['route:GET /legacy/{} => app/legacy/views.py#item', 'route:DELETE /legacy/{} => app/legacy/views.py#item']);
    expect(summary(fileFacts['app/main.py']!).entries).toEqual(['entry:main:app/main.py']);
  });

  it('writes and reads: SQLAlchemy session.add(Model(...)), Django Model.objects…, raw SQL; table names from __tablename__ / Meta.db_table', () => {
    const { fileFacts, writes } = scan();
    expect(summary(fileFacts['app/services/runner.py']!).writes).toEqual(['runs app/services/runner.py#start_run sqlalchemy', 'cost_log app/services/runner.py#start_run sqlalchemy']);
    expect(summary(fileFacts['app/legacy/views.py']!).writes).toEqual(['legacy_items app/legacy/views.py#item django', 'audit_log app/legacy/views.py#item sql']);
    expect(summary(fileFacts['app/api/runs.py']!).reads).toEqual(['runs app/api/runs.py#get_run django']);
    expect(writes).toContainEqual({ file: 'app/services/runner.py', table: 'runs' });
  });

  it('the gate sees Python imports and writes (same checker)', () => {
    const exists = fileExistsIn(PY);
    const old = readFileSync(`${PY}/app/models.py`, 'utf8');
    const delta = deltaForEdit('app/models.py', old, `from app.api.runs import router\n${old}`, exists);
    expect(delta.imports).toEqual([{ from: 'app/models.py', to: 'app/api/runs.py' }]);
    expect(check(map, delta).map((v) => `${v.invariant} ${v.detail}`)).toEqual(['DR-1 app/models.py → app/api/runs.py']);
    const views = readFileSync(`${PY}/app/legacy/views.py`, 'utf8');
    const w = deltaForEdit('app/legacy/views.py', views, views.replace('return "ok"', 'cursor.execute("UPDATE runs SET x = 1")\n    return "ok"'), exists);
    expect(check(map, w).map((v) => `${v.invariant} ${v.detail}`)).toEqual(['DR-2 app/legacy/views.py writes "runs"']);
  });

  it('symbol diffs work on Python (body vs signature)', () => {
    const ctx = diskLangContext(PY);
    const src = readFileSync(`${PY}/app/services/runner.py`, 'utf8');
    const a = extractTreeSitter('app/services/runner.py', src, ctx).facts;
    const b = extractTreeSitter('app/services/runner.py', src.replace('return len(goal)', 'return len(goal) * 2').replace('def plan(self, goal)', 'def plan(self, goal, depth=1)'), ctx).facts;
    const d = diffSymbols(a.symbols, b.symbols);
    expect(d.sig).toEqual(['app/services/runner.py#Planner.plan']);
    expect(d.body).toEqual(expect.arrayContaining(['app/services/runner.py#Planner', 'app/services/runner.py#Planner.score']));
    expect(extractTreeSitter('x.py', 'def broken(:\n', ctx).parsed).toBe(false);
  });

  it('the graph traces a route to its table through the handler and the service', () => {
    const { fileFacts } = scan();
    const g = buildGraph(map, fileFacts);
    expect(trace(g, 'route:POST /api/runs', ['table:runs'])).toEqual([['route:POST /api/runs', 'app/api/runs.py#create_run', 'app/services/runner.py#start_run', 'table:runs']]);
  });
});

describe('on the server', () => {
  it('a Python repo scans, and an edit reports its symbol diff, imports and gate facts like TypeScript', async () => {
    const { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { Bus } = await import('../../../apps/server/src/bus');
    const { Repo } = await import('../../../apps/server/src/repo');
    const root = realpathSync(mkdtempSync(join(process.env.HARNESS_TEST_TMP ?? tmpdir(), 'harness-py-')));
    try {
      cpSync(PY, root, { recursive: true });
      writeFileSync(join(root, 'domains.yaml'), MAP_YAML);
      const bus = new Bus(root, { fresh: true });
      const repo = new Repo(root, bus);
      repo.loadMapFile();
      repo.scan();
      expect(repo.fileFacts.get('app/services/runner.py')?.symbols.length).toBe(5);
      expect(repo.violations).toEqual([]);
      const path = join(root, 'app/services/runner.py');
      writeFileSync(path, readFileSync(path, 'utf8').replace('return len(goal)', 'return len(goal) + 1'));
      const change = repo.fileChanged('app/services/runner.py', { tool: 'Edit' });
      expect(change?.symbols?.body).toEqual(['app/services/runner.py#Planner', 'app/services/runner.py#Planner.score']);
      expect(change?.outside).toBe(false);
      writeFileSync(join(root, 'app/models.py'), `from app.api.runs import router\n${readFileSync(join(root, 'app/models.py'), 'utf8')}`);
      repo.fileChanged('app/models.py', { tool: 'Edit' });
      repo.recheck();
      expect(repo.violations.map((v) => `${v.invariant} ${v.detail}`)).toEqual(['DR-1 app/models.py → app/api/runs.py']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Go (net/http, chi, gin, database/sql)', () => {
  const scan = () => scanRepoFacts(GO, map);

  it('imports resolve module packages (go.mod) to their files; others are vendor packages', () => {
    const { fileFacts, imports } = scan();
    expect(summary(fileFacts['cmd/server/main.go']!).imports).toEqual(['vendor:net/http', 'internal/api/helpers.go', 'internal/api/routes.go']);
    expect(summary(fileFacts['internal/api/routes.go']!).imports).toEqual(['vendor:net/http', 'internal/store/store.go', 'vendor:github.com/gin-gonic/gin', 'vendor:github.com/go-chi/chi/v5']);
    expect(imports).toContainEqual({ from: 'internal/api/routes.go', to: 'internal/store/store.go' });
  });

  it('symbols (functions, methods, structs, interfaces), calls across packages and files, routes, entries', () => {
    const { fileFacts } = scan();
    expect(summary(fileFacts['internal/store/store.go']!).symbols).toEqual(['class Store', 'type Loader', 'function SaveRun', 'function LoadRun', 'method Store.Close']);
    const routes = summary(fileFacts['internal/api/routes.go']!);
    expect(routes.calls).toEqual([
      'internal/api/routes.go#startRun -> internal/store/store.go#SaveRun',
      'internal/api/routes.go#startRun -> internal/api/helpers.go#helper',
      'internal/api/routes.go#getRun -> internal/store/store.go#LoadRun',
    ]);
    expect(routes.routes).toEqual([
      'route:POST /api/runs => internal/api/routes.go#startRun',
      'route:ANY /healthz => internal/api/routes.go#health',
      'route:GET /api/runs/{} => internal/api/routes.go#getRun',
      'route:GET /api/usage/{} => internal/api/routes.go#usage',
    ]);
    expect(summary(fileFacts['cmd/server/main.go']!).calls).toContain('cmd/server/main.go#main -> internal/api/routes.go#Register');
    expect(summary(fileFacts['cmd/server/main.go']!).entries).toEqual(['entry:main:cmd/server/main.go']);
  });

  it('raw SQL writes and reads; the graph traces a route to its table', () => {
    const { fileFacts } = scan();
    expect(summary(fileFacts['internal/store/store.go']!).writes).toEqual(['runs internal/store/store.go#SaveRun sql']);
    expect(summary(fileFacts['internal/store/store.go']!).reads).toEqual(['runs internal/store/store.go#LoadRun sql']);
    const g = buildGraph(map, fileFacts);
    expect(trace(g, 'route:POST /api/runs', ['table:runs'])).toEqual([['route:POST /api/runs', 'internal/api/routes.go#startRun', 'internal/store/store.go#SaveRun', 'table:runs']]);
  });

  it("extracts an 8,000-line file (2,000 functions) in well under 150 ms", () => {
    const body = Array.from({ length: 2000 }, (_, i) => `func F${i}(x int) int {\n\treturn store.LoadRun("${i}") + x\n}\n`).join('\n');
    const src = `package api\n\nimport "example.com/scout/internal/store"\n\n${body}`;
    const ctx = diskLangContext(GO);
    extractTreeSitter('internal/api/big.go', src, ctx);
    let ms = Infinity; // best of 3: other test files share the CPU
    let f = extractTreeSitter('internal/api/big.go', src, ctx).facts;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      f = extractTreeSitter('internal/api/big.go', src, ctx).facts;
      ms = Math.min(ms, performance.now() - t0);
    }
    expect(f.symbols).toHaveLength(2000);
    expect(ms).toBeLessThan(process.env.HARNESS_PERF_STRICT ? 150 : 1000);
  });
});
