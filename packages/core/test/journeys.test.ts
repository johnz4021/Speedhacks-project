// Journeys (N10): fetch sites, fetch → route matching, and computeJourneys on the Scout fixture (hand-written facts and
// the Facts lane's extractor) and on a small UI → fetch → route repo.
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scanRepoFacts } from '../src/facts';
import { parseDomainMap } from '../src/schema';
import { buildGraph } from '../src/graph';
import { computeJourneys, findFetchSites, inferDispatch, journeyHash, journeySinks, journeySlug, linkFetches, matchRoute, urlPath, type FetchSite } from '../src/journeys';
import type { FileFacts, RouteFact } from '../src/contracts/facts';
import { fixtureRepo, loadMap } from './helpers';
import { scoutFacts } from './scout-facts';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const route = (method: string, path: string): RouteFact => ({ id: `route:${method} ${path}`, method, path, file: 'src/server.ts', handler: null });
const sitesOf = (files: Record<string, string>) => findFetchSites(Object.entries(files).map(([path, source]) => ({ path, source, symbols: [] })));

describe('findFetchSites', () => {
  it('finds direct fetches with literal and template URLs, axios/ky calls, and the method from the init or the client', () => {
    const sites = sitesOf({
      'web/a.ts': [
        'fetch("/api/runs");',
        'fetch(`/api/runs/${id}?full=1`, { method: "DELETE" });',
        "await fetch('https://example.com/api/x#frag', { headers: {}, method: 'put' });",
        'axios.post("/api/notes", body);',
        'ky.get(`/api/usage`);',
        'fetch(url);', // not a literal and not inside a named function: ignored
        'fetch(`${BASE}/api/runs`);', // dynamic origin: not a path
        'const s = "fetch(\\"/api/nope\\")";',
      ].join('\n'),
    });
    expect(sites.map((s) => `${s.method} ${s.url} ${s.exact} ${s.via}`)).toEqual([
      'GET /api/runs true null',
      'DELETE /api/runs/{} false null',
      'PUT /api/x true null',
      'POST /api/notes true axios.post',
      'GET /api/usage true ky.get',
    ]);
  });

  it('finds wrappers (fetch of a parameter, or `/api${path}`) and their literal call sites, in any file', () => {
    const sites = sitesOf({
      'web/api.ts': [
        'export async function request<T>(path: string, init?: RequestInit): Promise<T> {',
        '  const res = await fetch(path, { ...init });',
        '  return res.json();',
        '}',
        'export function apiGet(path: string) { return fetch(`/api${path}`); }',
        'export const api = { runs: () => request<{ runs: string[] }>("/api/runs?limit=25"), start: (b: unknown) => request("/api/runs", { method: "POST", body: JSON.stringify(b) }) };',
      ].join('\n'),
      'web/page.tsx': 'import { apiGet } from "./api";\nexport function Usage() { apiGet(`/usage/${month}`); return null; }\n',
    });
    expect(sites.map((s) => `${s.file} ${s.method} ${s.url} ${s.exact} ${s.via}`)).toEqual([
      'web/api.ts GET /api/runs true request',
      'web/api.ts POST /api/runs true request',
      'web/page.tsx GET /api/usage/{} false apiGet',
    ]);
  });

  it('names the innermost enclosing symbol from spans', () => {
    const source = 'export function A() {\n  return fetch("/api/a");\n}\n';
    const sym = (name: string, start: number, end: number) => ({ id: `w.ts#${name}`, file: 'w.ts', name, kind: 'function' as const, exported: true, parent: null, span: { start, end }, sigHash: '', bodyHash: '' });
    const [site] = findFetchSites([{ path: 'w.ts', source, symbols: [sym('A', 0, source.length), sym('Outer', 0, source.length + 10)] }]);
    expect(site!.from).toBe('w.ts#A');
    expect(urlPath('https://x.io')).toBeNull();
    expect(urlPath('/a//b/?q')).toBe('/a/b');
  });
});

describe('matchRoute', () => {
  const routes = [route('GET', '/api/runs'), route('POST', '/api/runs'), route('GET', '/api/runs/{}'), route('GET', '/api/runs/latest'), route('ANY', '/api/hook'), route('GET', '/api/accounts/{}/notes')];
  const site = (method: string, url: string, exact = true): Pick<FetchSite, 'method' | 'url' | 'exact'> => ({ method, url, exact });
  it('matches by method and segments, preferring the fewest wildcards', () => {
    expect(matchRoute(site('POST', '/api/runs'), routes)).toEqual({ route: routes[1], confidence: 'syntactic' });
    expect(matchRoute(site('GET', '/api/runs/latest'), routes)).toEqual({ route: routes[3], confidence: 'syntactic' });
    expect(matchRoute(site('GET', '/api/runs/r-1'), routes)).toEqual({ route: routes[2], confidence: 'syntactic' });
    expect(matchRoute(site('GET', '/api/runs/{}', false), routes)).toEqual({ route: routes[2], confidence: 'inferred' });
    expect(matchRoute(site('GET', '/api/accounts/{}/notes', false), routes)?.route.id).toBe('route:GET /api/accounts/{}/notes');
    expect(matchRoute(site('PATCH', '/api/hook'), routes)).toEqual({ route: routes[4], confidence: 'inferred' });
    expect(matchRoute(site('DELETE', '/api/runs'), routes)).toBeNull();
    expect(matchRoute(site('GET', '/api'), routes)).toBeNull();
  });
});

describe('computeJourneys on the Scout fixture', () => {
  it('hand-written facts: one CLI journey, deterministic', () => {
    const facts = scoutFacts();
    const g = buildGraph(loadMap(), facts);
    const js = computeJourneys(g, facts);
    expect(js.map((j) => j.id)).toEqual(['journey:cli-scout']);
    expect(js[0]!.steps.slice(0, 2)).toEqual([
      { node: 'entry:cli:scout', kind: 'entry', confidence: 'syntactic' },
      { node: 'src/channels/cli.ts', kind: 'symbol', confidence: 'syntactic' },
    ]);
    expect(js[0]).toMatchObject({ inferred: true, entry: 'entry:cli:scout', name: 'cli scout' });
    expect(computeJourneys(g, facts)).toEqual(js);
    expect(journeySinks(g)).toContain('table:runs');
    expect(journeySinks(g)).toContain('vendor/llm-openai/index.ts#chat');
  });

  it("the Facts lane's extractor: the route and the CLI trace to the gateway's provider (Scout's real pattern)", () => {
    const map = loadMap();
    map.cartography = { routes: [{ file: 'src/channels/routes.ts', pattern: 'req\\.method === "(?<method>[A-Z]+)" && req\\.url === "(?<path>[^"]+)"' }] };
    const { fileFacts } = scanRepoFacts(fixtureRepo, map);
    const g = buildGraph(map, fileFacts);
    const sources = Object.values(fileFacts).map((f) => ({ path: f.path, source: readFileSync(join(fixtureRepo, f.path), 'utf8'), symbols: f.symbols }));
    const js = computeJourneys(g, fileFacts, findFetchSites(sources));
    expect(js.map((j) => j.id)).toEqual(['journey:cli-scout', 'journey:post-runs']);
    const run = js.find((j) => j.id === 'journey:post-runs')!;
    expect(run.steps[0]).toEqual({ node: 'route:POST /runs', kind: 'route', confidence: 'syntactic' });
    expect(run.steps.map((s) => s.node)).toContain('src/orchestrator/agent.ts#runAgent');
    for (const j of js) {
      const last = j.steps.at(-1)!;
      expect(['vendor', 'table']).toContain(last.kind); // every journey reaches a sink
      for (const b of j.branches) {
        expect(b.from).toBeGreaterThanOrEqual(0);
        expect(b.from).toBeLessThan(j.steps.length - 1);
        expect(b.steps.length).toBeGreaterThan(0);
      }
    }
    const cli = js.find((j) => j.id === 'journey:cli-scout')!;
    expect(cli.steps.slice(0, 3).map((s) => s.kind)).toEqual(['entry', 'symbol', 'symbol']);
    expect(journeyHash(cli)).toBe(journeyHash({ steps: cli.steps.map((s) => ({ ...s })) }));
  });
});

/** A small web app + server: a page calls a wrapper (`/api${path}`), the server registers Express routes. */
const UI_REPO: Record<string, string> = {
  'package.json': '{ "name": "ui-fixture", "private": true, "type": "module", "dependencies": { "express": "4" } }',
  'web/src/api.ts': [
    'export async function request(path: string, init?: RequestInit) {',
    '  const res = await fetch(`/api${path}`, init);',
    '  return res.json();',
    '}',
    'export const startRun = (body: unknown) => request("/runs", { method: "POST", body: JSON.stringify(body) });',
    'export const getRun = (id: string) => request(`/runs/${id}`);',
    'export const health = () => fetch("/api/health");',
    '',
  ].join('\n'),
  'web/src/pages/ResearchPage.tsx': 'import { startRun } from "../api";\nexport function ResearchPage() {\n  void startRun({ company: "Acme" });\n  return <div>Research</div>;\n}\n',
  'src/server/routes.ts': [
    'import express from "express";',
    'import { runAgent, getRun } from "../agent/run";',
    'const app = express();',
    'app.post("/api/runs", async (req, res) => { res.json(await runAgent(req.body)); });',
    'app.get("/api/runs/:id", (req, res) => { res.json(getRun(req.params.id)); });',
    'export default app;',
    '',
  ].join('\n'),
  'src/agent/run.ts': [
    'import { chat } from "../../vendor/llm/index";',
    'import { db } from "../db";',
    'export async function runAgent(body: unknown) {',
    '  db.insert("runs", { body });',
    '  return chat(String(body));',
    '}',
    'export function getRun(id: string) { return id; }',
    '',
  ].join('\n'),
  'src/db.ts': 'export const db = { insert(table: string, row: unknown) { return [table, row]; } };\n',
  'vendor/llm/index.ts': 'export function chat(text: string) { return text; }\n',
};
const UI_MAP = `
version: 1
layers: [{ id: ui, name: UI }, { id: entry, name: Entry }, { id: logic, name: Logic }, { id: data, name: Data }, { id: external, name: External }]
neutral: ["src/db.ts"]
domains:
  - { id: web, name: Web, purpose: The app, cells: { ui: { paths: ["web/**"] } } }
  - { id: api, name: API, purpose: HTTP, cells: { entry: { paths: ["src/server/**"] } } }
  - { id: agent, name: Agent, purpose: Runs, cells: { logic: { paths: ["src/agent/**"] }, data: { tables: [runs] } } }
  - { id: llm, name: Model, purpose: Models, cells: { external: { paths: ["vendor/llm/**"] } } }
`;

describe('computeJourneys: UI page → fetch → route → handler trace', () => {
  const root = mkdtempSync(join(process.env.HARNESS_TEST_TMP ?? tmpdir(), 'harness-journeys-'));
  dirs.push(root);
  for (const [p, text] of Object.entries(UI_REPO)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); }
  const map = parseDomainMap(UI_MAP);
  const { fileFacts } = scanRepoFacts(root, map);
  const sources = Object.values(fileFacts).map((f) => ({ path: f.path, source: UI_REPO[f.path]!, symbols: f.symbols }));
  const sites = findFetchSites(sources);
  const g = buildGraph(map, fileFacts);
  const js = computeJourneys(g, fileFacts, sites);

  it('links wrapper call sites to routes (the `/api${path}` prefix is inferred); unmatched fetches drop out', () => {
    expect(sites.map((s) => `${s.from} ${s.method} ${s.url} ${s.via}`)).toEqual([
      'web/src/api.ts#startRun POST /api/runs request',
      'web/src/api.ts#getRun GET /api/runs/{} request',
      'web/src/api.ts#health GET /api/health null',
    ]);
    expect(linkFetches(sites, fileFacts).map((l) => `${l.site.from} → ${l.route.id} (${l.confidence})`)).toEqual([
      'web/src/api.ts#startRun → route:POST /api/runs (inferred)',
      'web/src/api.ts#getRun → route:GET /api/runs/{} (inferred)',
    ]);
  });

  it('draws the start-research journey end to end, with a branch to the table', () => {
    expect(js.map((j) => j.id)).toEqual(['journey:get-api-runs-id', 'journey:page-researchpage', 'journey:post-api-runs']);
    const run = js.find((j) => j.id === 'journey:post-api-runs')!;
    expect(run.entry).toBe('entry:route:POST /api/runs');
    expect(run.name).toBe('POST /api/runs');
    const handler = fileFacts['src/server/routes.ts']!.routes.find((r) => r.id === 'route:POST /api/runs')!.handler!;
    expect(run.steps).toEqual([
      { node: 'web/src/pages/ResearchPage.tsx#ResearchPage', kind: 'page', confidence: 'syntactic' },
      { node: 'web/src/api.ts#startRun', kind: 'fetch', confidence: 'syntactic' },
      { node: 'route:POST /api/runs', kind: 'route', confidence: 'inferred' },
      { node: handler, kind: 'symbol', confidence: 'syntactic' },
      { node: 'src/agent/run.ts#runAgent', kind: 'symbol', confidence: 'syntactic' },
      { node: 'vendor/llm/index.ts#chat', kind: 'vendor', confidence: 'syntactic' },
    ]);
    expect(run.branches).toEqual([{ from: 4, steps: ['table:runs'] }]);
    const get = js.find((j) => j.id === 'journey:get-api-runs-id')!;
    expect(get.steps.map((s) => `${s.kind}:${s.node}`).slice(0, 2)).toEqual(['fetch:web/src/api.ts#getRun', 'route:route:GET /api/runs/{}']);
    expect(get.steps[1]!.confidence).toBe('inferred');
  });

  it('a page entry (pages/ file route) flows through its fetch into the API', () => {
    const page = js.find((j) => j.id === 'journey:page-researchpage')!;
    expect(page.entry).toBe('entry:page:/ResearchPage');
    expect(page.steps.map((s) => `${s.kind}:${s.node}`)).toEqual([
      'entry:entry:page:/ResearchPage',
      'page:web/src/pages/ResearchPage.tsx',
      'page:web/src/pages/ResearchPage.tsx#ResearchPage',
      'fetch:web/src/api.ts#startRun',
      'route:route:POST /api/runs',
      expect.stringMatching(/^symbol:src\/server\/routes\.ts#/),
      'symbol:src/agent/run.ts#runAgent',
      'vendor:vendor/llm/index.ts#chat',
    ]);
  });

  it('is deterministic and slugs are stable', () => {
    expect(computeJourneys(buildGraph(map, fileFacts), fileFacts, findFetchSites([...sources].reverse()))).toEqual(js);
    expect(journeySlug({ kind: 'route', label: 'GET /api/accounts/{}/notes' })).toBe('get-api-accounts-id-notes');
    expect(journeySlug({ kind: 'bin', label: '@scope/x' })).toBe('bin-scope-x');
  });
});

/** A tool registry and a provider client: dispatch Tier 1 can't see (`tool?.run(…)`, `client.chat(…)`). */
const REGISTRY_REPO: Record<string, string> = {
  'package.json': '{ "name": "registry-fixture", "private": true, "type": "module", "scripts": { "agent": "tsx src/cli.ts" } }',
  'src/types.ts': 'export interface Tool {\n  name: string;\n  run(input: string): Promise<string>;\n}\n',
  'src/tools/a.ts': 'import type { Tool } from "../types";\nimport { complete } from "../gateway";\nexport const a: Tool = {\n  name: "a",\n  async run(input) { return complete(input); },\n};\n',
  'src/tools/b.ts': 'import type { Tool } from "../types";\nimport { Client } from "../../vendor/llm/index";\nconst client = new Client();\nexport const b: Tool = {\n  name: "b",\n  async run(input) { return client.chat(input); },\n};\n',
  'src/tools/not-a-tool.ts': 'import type { Tool } from "../types";\nexport const helper = { run(x: string) { return x; } };\nexport type T = Tool;\n',
  'src/registry.ts': 'import { a } from "./tools/a";\nimport { b } from "./tools/b";\nexport const tools = [a, b];\n',
  'src/agent.ts': 'import type { Tool } from "./types";\nimport { tools } from "./registry";\nexport async function runAgent(name: string) {\n  const tool: Tool | undefined = tools.find((t) => t.name === name);\n  return tool?.run(name);\n}\n',
  'src/gateway.ts': 'import { Client } from "../vendor/llm/index";\nexport function complete(text: string) {\n  return new Client().chat(text);\n}\n',
  'src/cli.ts': 'import { runAgent } from "./agent";\nvoid runAgent(process.argv[2] ?? "a");\n',
  'vendor/llm/index.ts': 'export class Client {\n  chat(text: string) { return text; }\n}\n',
};
const REGISTRY_MAP = `
version: 1
layers: [{ id: entry, name: Entry }, { id: logic, name: Logic }, { id: external, name: External }]
neutral: ["src/types.ts"]
domains:
  - { id: agent, name: Agent loop, purpose: Runs, cells: { entry: { paths: ["src/cli.ts"] }, logic: { paths: ["src/agent.ts", "src/registry.ts"] } } }
  - { id: tools, name: Tools, purpose: Tools, cells: { logic: { paths: ["src/tools/**"] } } }
  - { id: gateway, name: Gateway, purpose: Models, cells: { logic: { paths: ["src/gateway.ts"] }, external: { paths: ["vendor/llm/**"] } } }
`;

describe('computeJourneys through a registry (inferred dispatch)', () => {
  const root = mkdtempSync(join(process.env.HARNESS_TEST_TMP ?? tmpdir(), 'harness-registry-'));
  dirs.push(root);
  for (const [p, text] of Object.entries(REGISTRY_REPO)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); }
  const map = parseDomainMap(REGISTRY_MAP);
  const { fileFacts } = scanRepoFacts(root, map);
  const sources = Object.values(fileFacts).map((f) => ({ path: f.path, source: REGISTRY_REPO[f.path]!, symbols: f.symbols }));

  it('infers interface dispatch (declared implementations only) and calls through a module-level client', () => {
    expect(inferDispatch(sources, fileFacts).map((e) => `${e.kind} ${e.from} → ${e.to} (${e.confidence})`)).toEqual([
      'calls src/agent.ts#runAgent → src/types.ts#Tool.run (dispatch)',
      'calls src/tools/b.ts#b.run → vendor/llm/index.ts#Client (inferred)',
      'implements src/tools/a.ts#a.run → src/types.ts#Tool.run (dispatch)',
      'implements src/tools/b.ts#b.run → src/types.ts#Tool.run (dispatch)',
    ]);
  });

  it('the main path goes through the registry and the best tool; the other tool is a branch at the hub', () => {
    const js = computeJourneys(buildGraph(map, fileFacts), fileFacts, [], inferDispatch(sources, fileFacts));
    expect(js.map((j) => j.id)).toEqual(['journey:cli-agent']);
    const [j] = js;
    expect(j!.steps.map((s) => `${s.kind}/${s.confidence} ${s.node}`)).toEqual([
      'entry/syntactic entry:cli:agent',
      'symbol/syntactic src/cli.ts',
      'symbol/syntactic src/agent.ts#runAgent',
      'symbol/dispatch src/types.ts#Tool.run',
      'symbol/dispatch src/tools/a.ts#a.run',
      'symbol/syntactic src/gateway.ts#complete',
      'vendor/syntactic vendor/llm/index.ts#Client',
    ]);
    expect(j!.branches).toEqual([{ from: 3, steps: ['src/tools/b.ts#b.run', 'vendor/llm/index.ts#Client'] }]);
    // Without inferred edges the flow stops at the agent: nothing past the dynamic call is visible.
    expect(computeJourneys(buildGraph(map, fileFacts), fileFacts)[0]!.steps.map((s) => s.node)).not.toContain('vendor/llm/index.ts#Client');
  });
});
