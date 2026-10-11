import { describe, expect, it } from 'vitest';
import { fileExistsIn } from '../src/facts';
import { planFootprint, type PlanStep } from '../src/plan';
import { fixtureRepo, loadMap } from './helpers';

const map = loadMap();
const exists = fileExistsIn(fixtureRepo);

const tenKPlan = (modelImport: string): PlanStep[] => [
  {
    n: 1,
    text: 'Add a tool that summarizes the latest 10-K',
    files: ['src/tools/filing-summary.ts'],
    imports: [
      { from: 'src/tools/filing-summary.ts', to: 'vendor/sec-edgar/index' },
      { from: 'src/tools/filing-summary.ts', to: modelImport },
    ],
  },
  {
    n: 2,
    text: 'Register it in the tool list',
    files: ['src/tools/index.ts'],
    imports: [{ from: 'src/tools/index.ts', to: './filing-summary' }],
  },
  { n: 3, text: 'Test it', files: ['test/tools/filing-summary.test.ts', 'docs/notes.md'], imports: [] },
];

describe('planFootprint', () => {
  it('maps a gateway-bypassing 10-K plan to ghosts and a DR-1 violation', () => {
    const fp = planFootprint(map, tenKPlan('vendor/llm-openai/index'), exists);
    expect(fp.cells).toEqual([
      { domain: 'tools', layer: 'logic', steps: [1, 2], files: ['src/tools/filing-summary.ts', 'src/tools/index.ts'] },
    ]);
    expect(fp.tests).toEqual([{ domain: 'tools', files: ['test/tools/filing-summary.test.ts'] }]);
    expect(fp.unassigned).toEqual(['docs/notes.md']);
    expect(fp.edges).toEqual([
      {
        from: 'tools',
        to: 'gateway',
        steps: [1],
        imports: [{ from: 'src/tools/filing-summary.ts', to: 'vendor/llm-openai/index.ts' }],
      },
    ]);
    expect(fp.delta.imports).toContainEqual({ from: 'src/tools/index.ts', to: 'src/tools/filing-summary.ts' });
    expect(fp.delta.writes).toEqual([]);
    expect(fp.violations).toHaveLength(1);
    expect(fp.violations[0]).toMatchObject({ invariant: 'DR-1', file: 'src/tools/filing-summary.ts', target: 'vendor/llm-openai/index.ts' });
  });

  it('the same plan through the gateway has no violations', () => {
    const fp = planFootprint(map, tenKPlan('src/gateway/complete'), exists);
    expect(fp.violations).toEqual([]);
    expect(fp.edges).toEqual([
      { from: 'tools', to: 'gateway', steps: [1], imports: [{ from: 'src/tools/filing-summary.ts', to: 'src/gateway/complete.ts' }] },
    ]);
  });

  it('accepts relative specifiers, extensions and unresolvable paths', () => {
    const fp = planFootprint(
      map,
      [
        {
          n: 1,
          text: 'x',
          files: [],
          imports: [
            { from: './src/tools/web-search.ts', to: '../../vendor/llm-anthropic/index' },
            { from: 'src/tools/web-search.ts', to: 'src/outreach/send' },
            { from: 'src/tools/web-search.ts', to: 'src/tools/not-yet' },
          ],
        },
      ],
      exists,
    );
    expect(fp.cells).toEqual([{ domain: 'tools', layer: 'logic', steps: [1], files: ['src/tools/web-search.ts'] }]);
    expect(fp.violations.map((v) => [v.invariant, v.target])).toEqual([
      ['DR-1', 'vendor/llm-anthropic/index.ts'],
      ['DR-3', 'src/outreach/send.ts'],
    ]);
    expect(fp.delta.imports).toContainEqual({ from: 'src/tools/web-search.ts', to: 'src/tools/not-yet' });
    expect(fp.edges.map((e) => `${e.from}→${e.to}`)).toEqual(['tools→gateway', 'tools→outreach']);
  });
});
