import { describe, expect, it } from 'vitest';
import { parseDomainMap } from '../src/schema';
import { loadMap, mapYaml } from './helpers';

describe('parseDomainMap', () => {
  it('parses the Scout fixture', () => {
    const map = loadMap();
    expect(map.layers.map((l) => l.id)).toEqual(['ui', 'entry', 'logic', 'data', 'external']);
    expect(map.domains.map((d) => d.id)).toEqual(['channels', 'orchestrator', 'tools', 'gateway', 'memory', 'outreach']);
    expect(map.invariants.map((i) => [i.id, i.kind])).toEqual([
      ['DR-1', 'only_via'],
      ['DR-2', 'owns_writes'],
      ['DR-3', 'no_edge'],
    ]);
    expect(map.invariants[0]!.exceptions).toEqual([]);
  });

  it('normalizes string exceptions to { path }', () => {
    const map = parseDomainMap(mapYaml.replace('exceptions: []', 'exceptions: ["src/tools/x.ts", { path: src/y.ts, decision: DR-9 }]'));
    expect(map.invariants[0]!.exceptions).toEqual([{ path: 'src/tools/x.ts' }, { path: 'src/y.ts', decision: 'DR-9' }]);
  });

  it('throws readable errors on bad input', () => {
    expect(() => parseDomainMap('version: [')).toThrow(/not valid YAML/);
    expect(() => parseDomainMap('version: 1\nlayers: []\ndomains: [{ id: a }]')).toThrow(/invalid[\s\S]*name/);
    expect(() => parseDomainMap(mapYaml.replace('kind: no_edge', 'kind: nope'))).toThrow(/invalid/);
    expect(() => parseDomainMap(mapYaml.replace('to: outreach', 'to: billing'))).toThrow(/unknown domain "billing"/);
    expect(() => parseDomainMap(mapYaml.replace('logic: { paths: ["src/channels/validate.ts"] }', 'brains: {}'))).toThrow(/unknown layer "brains"/);
  });
});
