import { describe, expect, it } from 'vitest';
import { addException, linkDecision, nextDecisionId } from '../src/mapedit';
import { parseDomainMap } from '../src/schema';
import { loadMap, mapYaml } from './helpers';

/** Lines of `after` that are not in `before`, and how many lines `before` lost. */
function lineDiff(before: string, after: string) {
  const a = before.split('\n');
  const b = after.split('\n');
  return { added: b.filter((l) => !a.includes(l)), removed: a.filter((l) => !b.includes(l)).length };
}

describe('mapedit', () => {
  it('linkDecision adds a decisions line, then appends to it, touching nothing else', () => {
    const once = linkDecision(mapYaml, 'DR-1', 'DR-4');
    expect(lineDiff(mapYaml, once)).toEqual({ added: ['    decisions: [DR-4]'], removed: 0 });
    const twice = linkDecision(once, 'DR-1', 'DR-6');
    expect(lineDiff(mapYaml, twice)).toEqual({ added: ['    decisions: [DR-4, DR-6]'], removed: 0 });
    const map = parseDomainMap(twice);
    expect(map.invariants[0]!.decisions).toEqual(['DR-4', 'DR-6']);
    expect(map.invariants[1]!.decisions).toBeUndefined();
    // The last invariant in the file works too.
    expect(parseDomainMap(linkDecision(mapYaml, 'DR-3', 'DR-5')).invariants[2]!.decisions).toEqual(['DR-5']);
  });

  it('addException appends { path, decision } to a flow list, touching nothing else', () => {
    const out = addException(addException(mapYaml, 'DR-1', 'src/tools/news-summarize.ts', 'DR-4'), 'DR-1', 'src/tools/x.ts', 'DR-5');
    expect(lineDiff(mapYaml, out)).toEqual({
      added: ['    exceptions: [{ path: src/tools/news-summarize.ts, decision: DR-4 }, { path: src/tools/x.ts, decision: DR-5 }]'],
      removed: 0, // the replaced `exceptions: []` line still appears under DR-2 and DR-3
    });
    expect(out.split('\n')).toHaveLength(mapYaml.split('\n').length);
    expect(parseDomainMap(out).invariants[0]!.exceptions).toEqual([
      { path: 'src/tools/news-summarize.ts', decision: 'DR-4' },
      { path: 'src/tools/x.ts', decision: 'DR-5' },
    ]);
    expect(parseDomainMap(out).invariants[2]!.exceptions).toEqual([]);
  });

  it('appends to block lists and keeps trailing comments', () => {
    const block = mapYaml.replace(
      /(id: DR-2[\s\S]*?)exceptions: \[\]/,
      '$1exceptions:\n      - src/legacy/import.ts # migrated later\n      - { path: src/x.ts, decision: DR-7 }',
    );
    const out = addException(block, 'DR-2', 'src/tools/y.ts', 'DR-8');
    expect(lineDiff(block, out)).toEqual({ added: ['      - { path: src/tools/y.ts, decision: DR-8 }'], removed: 0 });
    expect(out).toContain('# migrated later');
    expect(parseDomainMap(out).invariants[1]!.exceptions).toEqual([
      { path: 'src/legacy/import.ts' },
      { path: 'src/x.ts', decision: 'DR-7' },
      { path: 'src/tools/y.ts', decision: 'DR-8' },
    ]);
  });

  it('throws for an unknown invariant', () => {
    expect(() => linkDecision(mapYaml, 'DR-99', 'DR-4')).toThrow(/no invariant DR-99/);
  });

  it('nextDecisionId returns the next free DR id', () => {
    expect(nextDecisionId(loadMap(), [])).toBe('DR-4');
    expect(nextDecisionId(loadMap(), ['DR-4', 'DR-7', 'notes'])).toBe('DR-8');
    expect(nextDecisionId(parseDomainMap(addException(mapYaml, 'DR-2', 'src/x.ts', 'DR-11')), [])).toBe('DR-12');
    expect(nextDecisionId(parseDomainMap(linkDecision(mapYaml, 'DR-3', 'DR-5')), [])).toBe('DR-6');
  });
});
