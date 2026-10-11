import { describe, expect, it } from 'vitest';
import { linkDecision, addException } from '../src/mapedit';
import { check } from '../src/rules';
import { parseDomainMap } from '../src/schema';
import { loadMap, mapYaml } from './helpers';

const map = loadMap();
const imp = (from: string, to: string) => ({ imports: [{ from, to }], writes: [] });
const write = (file: string, table: string) => ({ imports: [], writes: [{ file, table }] });

describe('check', () => {
  it('only_via: fires outside allowed domains, including tests and unassigned files', () => {
    const [v] = check(map, imp('src/tools/news-summarize.ts', 'vendor/llm-openai/index.ts'));
    expect(v).toEqual({
      invariant: 'DR-1',
      kind: 'only_via',
      reason:
        'src/tools/news-summarize.ts imports vendor/llm-openai/index.ts, but DR-1: Model providers are only called through the model gateway.',
      file: 'src/tools/news-summarize.ts',
      detail: 'src/tools/news-summarize.ts → vendor/llm-openai/index.ts',
      options: [
        'Route it through the Model gateway (every model call, with redaction and cost logging) instead of importing vendor/llm-openai/index.ts directly',
        'Add an exception for src/tools/news-summarize.ts and record why',
      ],
      target: 'vendor/llm-openai/index.ts',
    });
    expect(check(map, imp('test/memory/a.test.ts', 'vendor/embeddings/index.ts'))).toHaveLength(1);
    expect(check(map, imp('src/billing/x.ts', 'vendor/llm-anthropic/index.ts'))).toHaveLength(1);
  });

  it('only_via: allowed domains, their tests, neutral and ignored files pass', () => {
    expect(check(map, imp('src/gateway/providers.ts', 'vendor/llm-openai/index.ts'))).toEqual([]);
    expect(check(map, imp('test/gateway/complete.test.ts', 'vendor/llm-openai/index.ts'))).toEqual([]);
    expect(check(map, imp('src/shared/util.ts', 'vendor/llm-openai/index.ts'))).toEqual([]);
    expect(check(map, imp('scripts/proof.ts', 'vendor/llm-openai/index.ts'))).toEqual([]);
    expect(check(map, imp('src/tools/x.ts', 'vendor/news/index.ts'))).toEqual([]);
  });

  it('owns_writes: fires for a non-owner', () => {
    const [v] = check(map, write('src/tools/x.ts', 'contacts'));
    expect(v).toMatchObject({ invariant: 'DR-2', kind: 'owns_writes', file: 'src/tools/x.ts', target: 'contacts' });
    expect(v!.options[0]).toBe('Ask the Outreach domain to write contacts (call its function) instead of writing it here');
    expect(v!.reason).toBe('src/tools/x.ts writes "contacts", but DR-2: Each table is written only by the domain that owns it.');
    expect(check(map, write('src/outreach/crm-sync.ts', 'contacts'))).toEqual([]);
    expect(check(map, write('src/tools/x.ts', 'unowned_table'))).toEqual([]);
  });

  it('no_edge: fires for tools → outreach only', () => {
    const [v] = check(map, imp('src/tools/x.ts', 'src/outreach/send.ts'));
    expect(v).toMatchObject({ invariant: 'DR-3', kind: 'no_edge', target: 'src/outreach/send.ts' });
    expect(v!.options[0]).toBe('Remove the dependency from Research tools on Outreach');
    expect(check(map, imp('src/orchestrator/agent.ts', 'src/outreach/send.ts'))).toEqual([]);
  });

  it('exceptions suppress by exact path or glob', () => {
    const exact = parseDomainMap(addException(mapYaml, 'DR-1', 'src/tools/news-summarize.ts', 'DR-4'));
    expect(check(exact, imp('src/tools/news-summarize.ts', 'vendor/llm-openai/index.ts'))).toEqual([]);
    expect(check(exact, imp('src/tools/other.ts', 'vendor/llm-openai/index.ts'))).toHaveLength(1);
    const glob = parseDomainMap(mapYaml.replace('exceptions: []', 'exceptions: ["src/tools/**"]'));
    expect(check(glob, imp('src/tools/other.ts', 'vendor/llm-openai/index.ts'))).toEqual([]);
  });

  it('cites a linked decision', () => {
    const decided = parseDomainMap(linkDecision(mapYaml, 'DR-1', 'DR-4'));
    const [v] = check(decided, imp('src/tools/filing-summary.ts', 'vendor/llm-openai/index.ts'));
    expect(v!.decision).toBe('DR-4');
    expect(v!.reason).toMatch(/^You decided this in DR-4\. src\/tools\/filing-summary\.ts imports/);
  });

  it('dedupes and sorts by file, then invariant', () => {
    const delta = {
      imports: [
        { from: 'src/tools/b.ts', to: 'src/outreach/send.ts' },
        { from: 'src/tools/b.ts', to: 'vendor/llm-openai/index.ts' },
        { from: 'src/tools/a.ts', to: 'vendor/llm-openai/index.ts' },
        { from: 'src/tools/a.ts', to: 'vendor/llm-openai/index.ts' },
      ],
      writes: [{ file: 'src/tools/a.ts', table: 'runs' }],
    };
    expect(check(map, delta).map((v) => `${v.file} ${v.invariant}`)).toEqual([
      'src/tools/a.ts DR-1',
      'src/tools/a.ts DR-2',
      'src/tools/b.ts DR-1',
      'src/tools/b.ts DR-3',
    ]);
  });
});

describe('owns_writes and tests', () => {
  it('lets test files seed any table but still binds them by import rules', () => {
    const map = loadMap();
    expect(check(map, { imports: [], writes: [{ file: 'test/gateway/complete.test.ts', table: 'contacts' }] })).toEqual([]);
    expect(check(map, { imports: [{ from: 'test/memory/retrieve.test.ts', to: 'vendor/embeddings/index.ts' }], writes: [] }).map((v) => v.invariant)).toEqual(['DR-1']);
  });
});
