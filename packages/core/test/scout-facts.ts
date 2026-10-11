// Shared fixture for the NAVIGATION_PLAN lanes: FileFacts for test/fixture-repo (mirrors Scout).
// Imports and writes come from the real scanner; symbols, calls and routes are hand-written for the files the
// demo turns touch, until the Facts lane's extractor replaces them (its tests must reproduce these).
import { scanRepo } from '../src/facts';
import type { FileFacts, SymbolFact, CallFact, RouteFact } from '../src/contracts/facts';
import { fixtureRepo, loadMap } from './helpers';

const sym = (file: string, name: string, kind: SymbolFact['kind'], exported = true, parent: string | null = null): SymbolFact => ({
  id: `${file}#${name}`, file, name, kind, exported, parent, span: { start: 0, end: 0 }, sigHash: `sig:${name}`, bodyHash: `body:${file}#${name}`,
});
const call = (from: string, to: string, confidence: CallFact['confidence'] = 'syntactic'): CallFact => ({ from, to, confidence, count: 1 });

const SYMBOLS: Record<string, SymbolFact[]> = {
  'src/tools/news-summarize.ts': [sym('src/tools/news-summarize.ts', 'newsSummarize', 'const'), sym('src/tools/news-summarize.ts', 'newsSummarize.run', 'method', false, 'src/tools/news-summarize.ts#newsSummarize')],
  'src/tools/company-profile.ts': [sym('src/tools/company-profile.ts', 'companyProfile', 'const'), sym('src/tools/company-profile.ts', 'companyProfile.run', 'method', false, 'src/tools/company-profile.ts#companyProfile')],
  'src/tools/index.ts': [sym('src/tools/index.ts', 'tools', 'const')],
  'src/gateway/complete.ts': [sym('src/gateway/complete.ts', 'complete', 'function')],
  'src/gateway/redact.ts': [sym('src/gateway/redact.ts', 'redact', 'function')],
  'src/gateway/providers.ts': [sym('src/gateway/providers.ts', 'provider', 'function')],
  'src/gateway/cost-ledger.ts': [sym('src/gateway/cost-ledger.ts', 'logCost', 'function')],
  'src/orchestrator/tool-registry.ts': [sym('src/orchestrator/tool-registry.ts', 'registry', 'const')],
  'src/orchestrator/agent.ts': [sym('src/orchestrator/agent.ts', 'runAgent', 'function')],
  'src/channels/routes.ts': [sym('src/channels/routes.ts', 'server', 'const')],
  'vendor/llm-openai/index.ts': [sym('vendor/llm-openai/index.ts', 'chat', 'function')],
  'vendor/news/index.ts': [sym('vendor/news/index.ts', 'call', 'function')],
  'vendor/enrichment/index.ts': [sym('vendor/enrichment/index.ts', 'call', 'function')],
  'vendor/sec-edgar/index.ts': [sym('vendor/sec-edgar/index.ts', 'call', 'function')],
};

const CALLS: Record<string, CallFact[]> = {
  'src/tools/news-summarize.ts': [
    call('src/tools/news-summarize.ts#newsSummarize.run', 'vendor/news/index.ts#call'),
    call('src/tools/news-summarize.ts#newsSummarize.run', 'vendor/llm-openai/index.ts#chat'),
  ],
  'src/tools/company-profile.ts': [
    call('src/tools/company-profile.ts#companyProfile.run', 'src/gateway/complete.ts#complete'),
    call('src/tools/company-profile.ts#companyProfile.run', 'vendor/enrichment/index.ts#call'),
    call('src/tools/company-profile.ts#companyProfile.run', 'vendor/sec-edgar/index.ts#call'),
  ],
  'src/gateway/complete.ts': [
    call('src/gateway/complete.ts#complete', 'src/gateway/redact.ts#redact'),
    call('src/gateway/complete.ts#complete', 'src/gateway/providers.ts#provider'),
    call('src/gateway/complete.ts#complete', 'src/gateway/cost-ledger.ts#logCost'),
  ],
  'src/channels/routes.ts': [call('src/channels/routes.ts#server', 'src/orchestrator/agent.ts#runAgent')],
};

const ROUTES: Record<string, RouteFact[]> = {
  'src/channels/routes.ts': [{ id: 'route:POST /runs', method: 'POST', path: '/runs', file: 'src/channels/routes.ts', handler: 'src/channels/routes.ts#server' }],
};

/** FileFacts for every code file in the fixture repo (hash = 'fixture'). */
export function scoutFacts(): Record<string, FileFacts> {
  const map = loadMap();
  const facts = scanRepo(fixtureRepo, map);
  const out: Record<string, FileFacts> = {};
  for (const path of facts.files.filter((f) => /\.(ts|tsx|js|mjs)$/.test(f))) {
    out[path] = {
      path,
      hash: 'fixture',
      imports: facts.imports.filter((i) => i.from === path).map((i) => ({ to: i.to, typeOnly: false })),
      writes: facts.writes.filter((w) => w.file === path).map((w) => ({ table: w.table, symbol: null, via: 'db' })),
      symbols: SYMBOLS[path] ?? [],
      calls: CALLS[path] ?? [],
      routes: ROUTES[path] ?? [],
      entries: path === 'src/channels/cli.ts' ? [{ id: 'entry:cli:scout', kind: 'cli', file: path, symbol: null, label: 'scout' }] : [],
    };
  }
  return out;
}
