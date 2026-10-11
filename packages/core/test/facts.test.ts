import { describe, expect, it } from 'vitest';
import { applyEdit, deltaForEdit, domainEdges, factsForSource, fileExistsIn, scanRepo, withExtra } from '../src/facts';
import { createMapper } from '../src/mapper';
import { check } from '../src/rules';
import { fixtureRepo, loadMap } from './helpers';

const map = loadMap();
const mapper = createMapper(map);
const facts = scanRepo(fixtureRepo, map);
const exists = fileExistsIn(fixtureRepo);

describe('scanRepo (load scan)', () => {
  it('lists non-ignored files and skips ignored ones', () => {
    expect(facts.files).toContain('src/tools/news-summarize.ts');
    expect(facts.files).toContain('test/gateway/complete.test.ts');
    expect(facts.files).not.toContain('package.json');
    expect(facts.files.some((f) => f.startsWith('scripts/') || f.startsWith('fixtures/'))).toBe(false);
    expect(facts.imports.some((i) => i.from.startsWith('scripts/'))).toBe(false);
  });

  it('resolves extensionless, .js, directory and type imports, plus re-exports and dynamic imports', () => {
    const has = (from: string, to: string) => facts.imports.some((i) => i.from === from && i.to === to);
    expect(has('src/tools/news-summarize.ts', 'vendor/llm-openai/index.ts')).toBe(true);
    expect(has('src/channels/cli.ts', 'src/orchestrator/agent.ts')).toBe(true); // .js specifier
    expect(has('src/orchestrator/planner.ts', 'src/tools/index.ts')).toBe(true); // import type from a directory
    expect(has('src/orchestrator/tool-registry.ts', 'src/tools/index.ts')).toBe(true);
    expect(has('src/orchestrator/agent.ts', 'src/outreach/draft-email.ts')).toBe(true); // dynamic import()
    expect(has('src/tools/index.ts', 'src/tools/web-search.ts')).toBe(true); // import + export … from, once
    expect(facts.imports.filter((i) => i.from === 'src/tools/index.ts' && i.to === 'src/tools/web-search.ts')).toHaveLength(1);
    expect(has('src/tools/news-digest.ts', 'vendor/llm-openai/index.ts')).toBe(false); // commented out
    expect(facts.imports.some((i) => i.to.startsWith('node:'))).toBe(false);
  });

  it('finds every table write with its owner directory', () => {
    expect(facts.writes).toEqual(
      expect.arrayContaining([
        { file: 'src/orchestrator/run-state.ts', table: 'runs' },
        { file: 'src/gateway/cost-ledger.ts', table: 'cost_log' },
        { file: 'src/memory/notes-store.ts', table: 'notes' },
        { file: 'src/memory/notes-store.ts', table: 'embeddings' },
        { file: 'src/outreach/crm-sync.ts', table: 'contacts' },
        { file: 'src/outreach/outreach-log.ts', table: 'outreach_log' },
      ]),
    );
    expect(facts.writes).toHaveLength(6);
  });

  it('finds exactly one violation: DR-1 in src/tools/news-summarize.ts', () => {
    const violations = check(map, facts);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      invariant: 'DR-1',
      kind: 'only_via',
      file: 'src/tools/news-summarize.ts',
      target: 'vendor/llm-openai/index.ts',
    });
    expect(violations.some((v) => v.file.startsWith('test/'))).toBe(false);
  });

  it('derives cross-domain edges, none through neutral, test or vendor-internal files', () => {
    const edges = domainEdges(facts, mapper);
    const pairs = edges.map((e) => `${e.from}→${e.to}`);
    expect(pairs).toEqual([
      'channels→orchestrator',
      'memory→gateway',
      'orchestrator→gateway',
      'orchestrator→memory',
      'orchestrator→outreach',
      'orchestrator→tools',
      'outreach→gateway',
      'tools→gateway',
    ]);
    const tg = edges.find((e) => e.from === 'tools' && e.to === 'gateway')!;
    expect(tg.files).toContainEqual({ from: 'src/tools/news-summarize.ts', to: 'vendor/llm-openai/index.ts' });
    expect(edges.flatMap((e) => e.files).some((f) => /_calllog|shared\/|^test\//.test(f.from + ' ' + f.to))).toBe(false);
  });
});

describe('deltaForEdit / applyEdit', () => {
  const path = 'src/tools/web-search.ts';
  const current = factsSource();
  function factsSource() {
    return `import type { Tool } from "../shared/types";\nimport { call as search } from "../../vendor/search/index";\nimport { complete } from "../gateway/complete";\n`;
  }

  it('detects a forbidden import added by an Edit', () => {
    const next = applyEdit(current, `import { complete } from "../gateway/complete";`, `import { chat } from "../../vendor/llm-openai/index";`);
    const delta = deltaForEdit(path, current, next, exists);
    expect(delta).toEqual({ imports: [{ from: path, to: 'vendor/llm-openai/index.ts' }], writes: [] });
    expect(check(map, delta).map((v) => v.invariant)).toEqual(['DR-1']);
  });

  it('does not count re-saved or rewritten existing imports as added', () => {
    expect(deltaForEdit(path, current, current, exists)).toEqual({ imports: [], writes: [] });
    const renamed = applyEdit(current, 'import { complete }', 'import { complete as c2 }');
    expect(deltaForEdit(path, current, renamed, exists).imports).toEqual([]);
    // Multiset by target: a second import statement of the same file counts as added.
    expect(deltaForEdit(path, current, current + `import "../gateway/complete";\n`, exists).imports).toEqual([
      { from: path, to: 'src/gateway/complete.ts' },
    ]);
  });

  it('counts added writes as a multiset, and everything for a new file', () => {
    const oldSrc = `db.insert("contacts", a);\n`;
    expect(deltaForEdit('src/tools/x.ts', oldSrc, oldSrc + oldSrc, exists).writes).toEqual([{ file: 'src/tools/x.ts', table: 'contacts' }]);
    expect(deltaForEdit('src/tools/x.ts', null, `import "../gateway/complete";\ndb.insert("runs", r);`, exists)).toEqual({
      imports: [{ from: 'src/tools/x.ts', to: 'src/gateway/complete.ts' }],
      writes: [{ file: 'src/tools/x.ts', table: 'runs' }],
    });
    expect(factsForSource('./src/tools/x.ts', `db.insert("runs", r);`, exists).writes).toEqual([{ file: 'src/tools/x.ts', table: 'runs' }]);
  });

  it('applyEdit replaces once or all, and throws when old_string is missing', () => {
    expect(applyEdit('a a', 'a', 'b')).toBe('b a');
    expect(applyEdit('a a', 'a', 'b', true)).toBe('b b');
    expect(applyEdit('a', 'a', '$&$&')).toBe('$&$&');
    expect(() => applyEdit('a', 'z', 'b')).toThrow(/not found/);
  });
});

describe('fileExistsIn / withExtra', () => {
  it('checks files only, and accepts planned files', () => {
    expect(exists('src/tools/index.ts')).toBe(true);
    expect(exists('src/tools')).toBe(false);
    expect(exists('src/tools/filing-summary.ts')).toBe(false);
    expect(withExtra(exists, ['./src/tools/filing-summary.ts'])('src/tools/filing-summary.ts')).toBe(true);
  });
});
