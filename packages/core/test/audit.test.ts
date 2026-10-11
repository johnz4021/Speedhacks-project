// Auditor (N9), pure parts: turn surface, the pre-filter, finding signatures and dismissal memory, numbered diffs, and
// the deterministic rule proposals (reinforcement, promote). No model anywhere.
import { describe, expect, it } from 'vitest';
import {
  acceptFindings, amendedRuleText, changeRuleProposal, factDelta, findingSignature, isDismissed, manualRuleProposal, nextFindingId,
  normalizeFindingText, numberDiff, reinforcedRuleText, reinforcementSignal, reinforcements, relevantDecisions, setRuleText, turnSurface, planSurface,
  type AuditDecision, type DismissedFinding, type RawFinding, type TurnSurface,
} from '../src/audit';
import { parseDomainMap } from '../src/schema';
import type { HarnessEvent, EventData, EventKind } from '../src/events';
import type { FileFacts } from '../src/contracts/facts';
import { emptySymbolDiff } from '../src/contracts/facts';
import { loadMap, mapYaml } from './helpers';
import { scoutFacts } from './scout-facts';

const map = loadMap();

const DR4: AuditDecision = {
  id: 'DR-4', title: 'Filings go through the gateway', outcome: 'Route filings through complete() with a filings redaction mode', invariant: 'DR-1',
  paths: ['src/tools/filing-summarize.ts'],
  rationale: 'The user chose A, in their words: "A — go through the gateway, and give redaction a filings mode so the figures survive."',
};
const DR5: AuditDecision = { id: 'DR-5', title: 'Research tools stay out of outreach', outcome: 'Keep tools independent', invariant: 'DR-3', paths: ['src/tools/company-profile.ts'], rationale: 'So research runs without CRM credentials.' };
const DR6: AuditDecision = { id: 'DR-6', title: 'Every model call is costed', outcome: 'Always call logCost', invariant: '', paths: ['src/gateway/cost-ledger.ts'], rationale: 'Usage must reconcile with the invoice: nothing skips logCost.' };
const DR7: AuditDecision = { id: 'DR-7', title: 'Notes are written by memory only', outcome: 'Use notes-store', invariant: 'DR-2', paths: ['src/memory/notes-store.ts'], rationale: 'One writer for notes.' };
const ALL = [DR7, DR6, DR5, DR4];

const surface = (over: Partial<TurnSurface>): TurnSurface => ({
  turn: 't1', prompt: 'p', baseline: null, source: 'turn', files: [], created: [], symbols: [], delta: { calls: [], imports: [], writes: [] }, plan: [], violations: [], ...over,
});

describe('relevantDecisions (pre-filter)', () => {
  it('a new filings tool calling complete(): the DR-1 decision (via the gateway) and the tools-side DR-3 decision, with reasons', () => {
    const s = surface({
      files: ['src/tools/filings-digest.ts'], created: ['src/tools/filings-digest.ts'], symbols: ['src/tools/filings-digest.ts#filingsDigest', 'src/tools/filings-digest.ts#filingsDigest.run'],
      delta: { calls: [{ from: 'src/tools/filings-digest.ts#filingsDigest.run', to: 'src/gateway/complete.ts#complete' }], imports: [{ from: 'src/tools/filings-digest.ts', to: 'src/gateway/complete.ts' }], writes: [] },
    });
    const r = relevantDecisions(ALL, map, s);
    expect(r.map((x) => x.decision.id)).toEqual(['DR-4', 'DR-5']);
    expect(r[0]!.reasons.map((x) => x.kind)).toEqual(['invariant', 'mention']);
    expect(r[0]!.reasons[0]!.detail).toContain('gateway');
    expect(r[0]!.reasons[1]!.detail).toContain('"filings"');
  });

  it('anchors, exceptions, invariant targets, table owners and named symbols each make a decision relevant', () => {
    expect(relevantDecisions(ALL, map, surface({ files: ['src/tools/filing-summarize.ts'] })).map((x) => [x.decision.id, x.reasons.map((y) => y.kind).join('+')]))
      .toEqual([['DR-4', 'anchor']]);
    expect(relevantDecisions(ALL, map, surface({ files: ['src/memory/notes-store.ts'], symbols: ['src/memory/notes-store.ts#save'] })).map((x) => x.decision.id)).toEqual(['DR-7']);
    expect(relevantDecisions(ALL, map, surface({ files: ['vendor/llm-openai/index.ts'] })).map((x) => x.decision.id)).toEqual(['DR-4']);
    const calls = surface({ files: ['src/outreach/send.ts'], delta: { calls: [{ from: 'src/outreach/send.ts#send', to: 'src/gateway/cost-ledger.ts#logCost' }], imports: [], writes: [] } });
    expect(relevantDecisions(ALL, map, calls).map((x) => x.decision.id)).toEqual(['DR-4', 'DR-5', 'DR-6']); // DR-1 gateway reach, DR-3 `to` side changed, DR-6 anchor + names logCost
    const excepted = parseDomainMap(mapYaml.replace('targets: ["vendor/llm-*/**", "vendor/embeddings/**"]\n    allowed_from: [gateway]\n    exceptions: []', 'targets: ["vendor/llm-*/**", "vendor/embeddings/**"]\n    allowed_from: [gateway]\n    exceptions: [{ path: src/tools/news-summarize.ts, decision: DR-4 }]'));
    expect(relevantDecisions([DR4], excepted, surface({ files: ['src/tools/news-summarize.ts'] }))[0]!.reasons[0]!.detail).toContain('exception');
  });

  it('nothing relevant → empty (the model call is skipped)', () => {
    expect(relevantDecisions(ALL, map, surface({ files: ['src/channels/validate.ts'], symbols: ['src/channels/validate.ts#validate'] }))).toEqual([]);
    expect(relevantDecisions([], map, surface({ files: ['src/tools/filing-summarize.ts'] }))).toEqual([]);
  });
});

describe('finding signatures and dismissal memory', () => {
  const f: RawFinding = { decision: 'DR-4', files: ['src/tools/filings-digest.ts'], lines: [{ path: 'src/tools/filings-digest.ts', line: 7 }], text: 'DR-4 says filings use redaction: "filings"; line 7 calls complete() without it.', confidence: 'high' };

  it('ignores line numbers, case, punctuation and file order', () => {
    expect(normalizeFindingText('Line 7 calls COMPLETE() — src/a.ts:12 without it!')).toBe('calls complete src a ts without it');
    expect(findingSignature(f)).toBe(findingSignature({ ...f, text: 'DR-4 says filings use redaction "filings". Line 31 calls complete() without it' }));
    expect(findingSignature(f)).not.toBe(findingSignature({ ...f, decision: 'DR-5' }));
    expect(findingSignature({ ...f, files: ['b', 'a'] })).toBe(findingSignature({ ...f, files: ['a', 'b', 'a'] }));
  });

  it('a dismissed finding stays dismissed, including close rephrasings for the same decision and files', () => {
    const d: DismissedFinding[] = [{ signature: findingSignature(f), decision: f.decision, files: f.files, text: f.text }];
    expect(isDismissed(f, d)).toBe(true);
    expect(isDismissed({ ...f, text: 'DR-4 says filings use redaction "filings"; this new line calls complete() without it.' }, d)).toBe(true);
    expect(isDismissed({ ...f, text: 'The digest caches figures in memory, against DR-4.' }, d)).toBe(false);
    expect(isDismissed({ ...f, files: ['src/tools/other.ts'] }, d)).toBe(false);
  });

  it('acceptFindings keeps only cited, changed-file, new findings and cleans them up', () => {
    const raw: RawFinding[] = [
      f,
      { ...f, decision: 'DR-9' }, // not sent
      { ...f, decision: null }, // no decision
      { ...f, files: ['src/untouched.ts'], lines: [{ path: 'src/untouched.ts', line: 1 }] }, // not a changed file
      { ...f, text: '  ' },
      { ...f, text: f.text.replace('7', '8') }, // duplicate of the first (line numbers don't count)
      { decision: 'DR-4', files: [], lines: [{ path: './src/tools/filings-digest.ts', line: 3.7 }, { path: 'src/other.ts', line: 2 }, { path: 'src/tools/filings-digest.ts', line: -1 }], text: 'Second finding on the cache.', confidence: 'certain' as never },
    ];
    const out = acceptFindings(raw, { decisions: ['DR-4'], files: ['src/tools/filings-digest.ts'], dismissed: [], open: [] });
    expect(out).toEqual([
      f,
      { decision: 'DR-4', files: ['src/tools/filings-digest.ts'], lines: [{ path: 'src/tools/filings-digest.ts', line: 3 }], text: 'Second finding on the cache.', confidence: 'low' },
    ]);
    expect(acceptFindings([f], { decisions: ['DR-4'], files: f.files, dismissed: [], open: [f] })).toEqual([]); // already open
    expect(acceptFindings([f], { decisions: ['DR-4'], files: f.files, dismissed: [{ signature: findingSignature(f), decision: 'DR-4', files: f.files, text: f.text }], open: [] })).toEqual([]);
    expect(nextFindingId(['AF-2', 'AF-10', 'MP-40'])).toBe('AF-11');
    expect(nextFindingId([])).toBe('AF-1');
  });
});

describe('numberDiff', () => {
  it('numbers new-file lines for modified and new files', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts',
      '@@ -3,3 +3,4 @@ export', ' keep();', '-old();', '+fresh();', '+more();', ' tail();',
      'diff --git a/dev/null b/src/new.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1,2 @@', '+line one', '+line two', '\\ No newline at end of file',
    ].join('\n');
    expect(numberDiff(diff)).toBe([
      '### src/a.ts', '   3   keep();', '     - old();', '   4 + fresh();', '   5 + more();', '   6   tail();',
      '### src/new.ts (new file)', '   1 + line one', '   2 + line two',
    ].join('\n'));
    expect(numberDiff(diff, 2).split('\n')).toContain('     … (3 more lines)');
  });
});

// ---- a synthetic event log for turnSurface
let n = 0;
const ev = <K extends EventKind>(kind: K, data: K extends keyof EventData ? EventData[K] : never, extra: Partial<HarnessEvent> = {}): HarnessEvent =>
  ({ id: `e${n++}`, t: n, session: 's', turn: extra.turn ?? null, kind, data: data as Record<string, unknown>, ...extra });

describe('turnSurface / planSurface', () => {
  const facts = scoutFacts();
  const before = facts['src/tools/company-profile.ts']!;
  const after: FileFacts = {
    ...before, hash: 'h2',
    imports: [...before.imports, { to: 'src/outreach/send.ts', typeOnly: false }],
    calls: [...before.calls, { from: 'src/tools/company-profile.ts#companyProfile.run', to: 'src/outreach/send.ts#send', confidence: 'syntactic', count: 1 }],
    writes: [{ table: 'contacts', symbol: null, via: 'db' }],
  };
  const created: FileFacts = { path: 'src/tools/filings-digest.ts', hash: 'h3', imports: [{ to: 'src/gateway/complete.ts', typeOnly: false }], writes: [], symbols: [], calls: [{ from: 'src/tools/filings-digest.ts#run', to: 'src/gateway/complete.ts#complete', confidence: 'syntactic', count: 1 }], routes: [], entries: [] };
  const events: HarnessEvent[] = [
    ev('map_confirmed', { map, source: 'fixture' }),
    ev('repo_scanned', { files: [], imports: [], writes: [], edges: [], fileFacts: Object.values(facts) }),
    ev('turn_started', { prompt: 'add a filings digest', head: 'HEAD0', baseline: 'SNAP0' }, { turn: 't1' }),
    ev('planned', { steps: [{ n: 1, text: 'digest', files: ['src/tools/filings-digest.ts#run'], imports: [{ from: 'src/tools/filings-digest.ts', to: 'src/gateway/complete.ts' }] }], cells: [], edges: [], unassigned: [] }, { turn: 't1' }),
    ev('edited', { added: 3, removed: 0, created: false, symbols: { ...emptySymbolDiff(), body: ['src/tools/company-profile.ts#companyProfile.run'] } }, { turn: 't1', path: 'src/tools/company-profile.ts' }),
    ev('facts_changed', { facts: after }, { turn: 't1', path: 'src/tools/company-profile.ts' }),
    ev('edited', { added: 9, removed: 0, created: true, symbols: { ...emptySymbolDiff(), added: ['src/tools/filings-digest.ts#run'], renamed: [['a#x', 'src/tools/filings-digest.ts#y']] } }, { turn: 't1', path: 'src/tools/filings-digest.ts' }),
    ev('facts_changed', { facts: created }, { turn: 't1', path: 'src/tools/filings-digest.ts' }),
  ];

  it('is null until the turn ends; then files, symbols, baseline and the fact delta come from the log', () => {
    expect(turnSurface(events, 't1')).toBeNull();
    const done = [...events, ev('turn_ended', { added: 12, removed: 0, files: ['src/tools/company-profile.ts', 'src/tools/filings-digest.ts', 'domains.yaml', 'scripts/x.ts'], reason: 'success' }, { turn: 't1' })];
    const s = turnSurface(done, 't1')!;
    expect(s).toMatchObject({ turn: 't1', prompt: 'add a filings digest', baseline: 'SNAP0', source: 'turn' });
    expect(s.files).toEqual(['scripts/x.ts', 'src/tools/company-profile.ts', 'src/tools/filings-digest.ts']);
    expect(s.created).toEqual(['src/tools/filings-digest.ts']);
    expect(s.symbols).toEqual(['src/tools/company-profile.ts#companyProfile.run', 'src/tools/filings-digest.ts#run', 'src/tools/filings-digest.ts#y']);
    expect(s.delta).toEqual({
      calls: [
        { from: 'src/tools/company-profile.ts#companyProfile.run', to: 'src/outreach/send.ts#send' },
        { from: 'src/tools/filings-digest.ts#run', to: 'src/gateway/complete.ts#complete' },
      ],
      imports: [{ from: 'src/tools/company-profile.ts', to: 'src/outreach/send.ts' }, { from: 'src/tools/filings-digest.ts', to: 'src/gateway/complete.ts' }],
      writes: [{ file: 'src/tools/company-profile.ts', table: 'contacts' }],
    });
    expect(s.plan).toHaveLength(1);
    expect(turnSurface(done, 'nope')).toBeNull();
    expect(factDelta({}, {}, ['x'])).toEqual({ calls: [], imports: [], writes: [] });
  });

  it('planSurface reads the latest plan of an open turn', () => {
    const p = planSurface(events, 't1')!;
    expect(p).toMatchObject({ source: 'plan', baseline: null, files: ['src/tools/filings-digest.ts'], symbols: ['src/tools/filings-digest.ts#run'] });
    expect(p.delta.imports).toEqual([{ from: 'src/tools/filings-digest.ts', to: 'src/gateway/complete.ts' }]);
    expect(planSurface(events.slice(0, 3), 't1')).toBeNull();
  });
});

describe('rule proposals (reinforcement, promote)', () => {
  const dec = (id: string, option: 'A' | 'B', paths: string[], invariant = 'DR-1') => ({ id, title: id, invariant, option, paths });

  it('reinforcements: option A ≥ 3 times on one invariant in one domain (deduped by id; B and other domains don\'t count)', () => {
    const tools = ['src/tools/a.ts'];
    expect(reinforcements([dec('DR-4', 'A', tools), dec('DR-5', 'A', ['src/tools/b.ts']), dec('DR-6', 'B', tools), dec('DR-7', 'A', ['src/memory/retrieve.ts'])], map)).toEqual([]);
    const r = reinforcements([dec('DR-4', 'A', tools), dec('DR-4', 'A', tools), dec('DR-5', 'A', ['src/tools/b.ts']), dec('DR-8', 'A', ['src/tools/c.ts', 'src/tools/a.ts'])], map);
    expect(r).toEqual([{ invariant: 'DR-1', domain: 'tools', decisions: ['DR-4', 'DR-5', 'DR-8'], paths: ['src/tools/a.ts', 'src/tools/b.ts', 'src/tools/c.ts'] }]);
    expect(reinforcements([dec('DR-4', 'A', tools), dec('DR-5', 'A', tools), dec('DR-6', 'A', tools, 'DR-99')], map, 2)).toEqual([expect.objectContaining({ decisions: ['DR-4', 'DR-5'] })]); // unknown invariant dropped
    expect(reinforcementSignal(r[0]!)).toMatchObject({ signal: 'rule_reinforcement', value: 3, scope: ['rule:DR-1', 'domain:tools'] });
    const text = reinforcedRuleText('Model providers are only called through the model gateway', r[0]!, 'Research tools');
    expect(text).toBe('Model providers are only called through the model gateway (confirmed 3× for Research tools: DR-4, DR-5, DR-8)');
    expect(reinforcedRuleText(text, { ...r[0]!, decisions: ['DR-4', 'DR-5', 'DR-8', 'DR-9'] }, 'Research tools')).toBe('Model providers are only called through the model gateway (confirmed 4× for Research tools: DR-4, DR-5, DR-8, DR-9)');
  });

  it('setRuleText changes only that rule line; changeRuleProposal carries a valid candidate and a change_rule', () => {
    const rule = amendedRuleText('Model providers are only called through the model gateway', { id: 'DR-4', title: 'Filings go through the gateway with redaction: "filings".' });
    expect(rule).toBe('Model providers are only called through the model gateway; DR-4: Filings go through the gateway with redaction: "filings"');
    expect(amendedRuleText(rule, { id: 'DR-4', title: 'Filings go through the gateway with redaction: "filings"' })).toBe(rule);
    const yaml = setRuleText(mapYaml, 'DR-1', rule);
    const changed = yaml.split('\n').filter((l, i) => l !== mapYaml.split('\n')[i]);
    expect(changed).toEqual([`    rule: ${JSON.stringify(rule)}`]);
    expect(parseDomainMap(yaml).invariants[0]!.rule).toBe(rule);
    expect(() => setRuleText(mapYaml, 'DR-99', 'x')).toThrow(/DR-99/);

    const facts = scoutFacts();
    const p = changeRuleProposal({ id: 'MP-3', yaml: mapYaml, map, facts, history: [], trigger: [], scope: ['src/tools/x.ts', 'rule:DR-1', 'rule:DR-1'], rationale: 'r', invariant: 'DR-1', rule });
    expect(p).toMatchObject({ id: 'MP-3', chosen: 0, scope: ['rule:DR-1', 'src/tools/x.ts'], changes: [{ kind: 'change_rule', invariant: 'DR-1', rule }] });
    expect(p.candidates).toHaveLength(1);
    expect(p.candidates[0]!.yaml).toBe(yaml);
    expect(p.candidates[0]!.score.total).toBe(p.current.total); // rule text doesn't move the map's score

    const m = manualRuleProposal({ id: 'MP-4', yaml: mapYaml, map, facts, history: [], trigger: [], scope: [], rationale: 'r', invariant: 'AF-1', rule: 'DR-9: something' });
    expect(m).toMatchObject({ candidates: [], chosen: 0, changes: [{ kind: 'add_rule', invariant: 'AF-1', rule: 'DR-9: something' }] });
  });
});
