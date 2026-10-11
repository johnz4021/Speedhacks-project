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

// The demo's DR-4 (DEMO_PLAN beat 3): option A on DR-3 (no_edge tools → outreach).
const DR4: AuditDecision = {
  id: 'DR-4', title: 'Research tools never read outreach data; the run loop passes outreach context in',
  outcome: 'Keep research tools out of outreach data; the run loop passes outreach context in', invariant: 'DR-3',
  paths: ['src/tools/outreach-history.ts'],
  rationale: 'The user chose A, in their words: "A. Research tools never read outreach data; the run loop passes it in."\n\nWhat triggered it: src/tools/outreach-history.ts imports src/outreach/outreach-log.ts, but Research tools never depend on Outreach (DR-3).',
};
const DR5: AuditDecision = { id: 'DR-5', title: 'Model calls go through complete()', outcome: 'Use the gateway', invariant: 'DR-1', paths: ['src/tools/news-summarize.ts'], rationale: 'One place redacts personal data and records cost.' };
const DR6: AuditDecision = { id: 'DR-6', title: 'Every model call is costed', outcome: 'Always call logCost', invariant: '', paths: ['src/gateway/cost-ledger.ts'], rationale: 'Usage must reconcile with the invoice: nothing skips logCost.' };
const DR7: AuditDecision = { id: 'DR-7', title: 'Notes are written by memory only', outcome: 'Use notes-store', invariant: 'DR-2', paths: ['src/memory/notes-store.ts'], rationale: 'One writer for notes.' };
const ALL = [DR7, DR6, DR5, DR4];

const none = { calls: [], imports: [], writes: [], reads: [] };
const surface = (over: Partial<TurnSurface>): TurnSurface => ({
  turn: 't1', prompt: 'p', baseline: null, source: 'turn', files: [], created: [], symbols: [], delta: none, plan: [], violations: [], ...over,
});

/** Beat 6: a new research tool reads `outreach_log` through neutral shared db code (no import edge, reads unchecked). */
const READER = 'src/tools/contact-history.ts';
const beat6 = (reads: boolean) => surface({
  files: [READER], created: [READER], symbols: [`${READER}#contactHistory`, `${READER}#contactHistory.run`],
  delta: { ...none, imports: [{ from: READER, to: 'src/shared/db.ts' }], calls: [{ from: `${READER}#contactHistory.run`, to: 'src/shared/db.ts#db.where' }], reads: reads ? [{ file: READER, table: 'outreach_log' }] : [] },
});

describe('relevantDecisions (pre-filter)', () => {
  it('a research tool reading outreach_log through shared code: DR-4 (on DR-3), with the read as the reason', () => {
    const r = relevantDecisions(ALL, map, beat6(true));
    expect(r.map((x) => x.decision.id)).toEqual(['DR-4']); // DR-7 (owns_writes) only cares about writes
    expect(r[0]!.reasons).toEqual([{ kind: 'invariant', detail: 'src/tools/contact-history.ts newly reads "outreach_log" (owned by outreach)' }]);
    // Before the facts carry reads, touching the tools domain is enough.
    expect(relevantDecisions(ALL, map, beat6(false))[0]!.reasons[0]!.detail).toBe('the turn changed files in tools, an end of DR-3 (tools → outreach)');
    // A read of an outreach table from any domain bears on DR-3.
    expect(relevantDecisions([DR4], map, surface({ files: ['src/memory/retrieve.ts'], delta: { ...none, reads: [{ file: 'src/memory/retrieve.ts', table: 'contacts' }] } })).map((x) => x.decision.id)).toEqual(['DR-4']);
  });

  it('anchors, exceptions, invariant targets, table writes and named symbols each make a decision relevant', () => {
    expect(relevantDecisions(ALL, map, surface({ files: ['src/tools/outreach-history.ts'] })).map((x) => [x.decision.id, x.reasons.map((y) => y.kind).join('+')]))
      .toEqual([['DR-4', 'anchor+invariant+mention']]); // mention: the rationale names the path
    expect(relevantDecisions(ALL, map, surface({ files: ['src/memory/notes-store.ts'], symbols: ['src/memory/notes-store.ts#save'] })).map((x) => x.decision.id)).toEqual(['DR-7']);
    expect(relevantDecisions(ALL, map, surface({ files: ['src/channels/routes.ts'], delta: { ...none, writes: [{ file: 'src/channels/routes.ts', table: 'notes' }] } })).map((x) => x.decision.id)).toEqual(['DR-7']);
    expect(relevantDecisions(ALL, map, surface({ files: ['vendor/llm-anthropic/index.ts'] })).map((x) => x.decision.id)).toEqual(['DR-5']);
    const calls = surface({ files: ['src/outreach/send.ts'], delta: { ...none, calls: [{ from: 'src/outreach/send.ts#send', to: 'src/gateway/cost-ledger.ts#logCost' }] } });
    expect(relevantDecisions(ALL, map, calls).map((x) => x.decision.id)).toEqual(['DR-4', 'DR-5', 'DR-6']); // DR-3 end changed, DR-1 gateway reach, DR-6 anchor + names logCost
    const excepted = parseDomainMap(mapYaml.replace('targets: ["vendor/llm-*/**", "vendor/embeddings/**"]\n    allowed_from: [gateway]\n    exceptions: []', 'targets: ["vendor/llm-*/**", "vendor/embeddings/**"]\n    allowed_from: [gateway]\n    exceptions: [{ path: src/tools/news-summarize.ts, decision: DR-5 }]'));
    expect(relevantDecisions([DR5], excepted, surface({ files: ['src/tools/news-summarize.ts'] }))[0]!.reasons.map((x) => x.detail)).toContain('src/tools/news-summarize.ts is an exception to DR-1');
  });

  it('nothing relevant → empty (the model call is skipped)', () => {
    expect(relevantDecisions(ALL, map, surface({ files: ['src/channels/validate.ts'], symbols: ['src/channels/validate.ts#validate'] }))).toEqual([]);
    expect(relevantDecisions([], map, beat6(true))).toEqual([]);
  });
});

describe('finding signatures and dismissal memory', () => {
  const f: RawFinding = { decision: 'DR-4', files: [READER], lines: [{ path: READER, line: 7 }], text: 'DR-4 says outreach history reaches the brief through the run loop; line 7 reads outreach_log directly.', confidence: 'high' };

  it('ignores line numbers, case, punctuation and file order', () => {
    expect(normalizeFindingText('Line 7 reads OUTREACH_LOG — src/a.ts:12 directly!')).toBe('reads outreach log src a ts directly');
    expect(findingSignature(f)).toBe(findingSignature({ ...f, text: 'DR-4 says outreach history reaches the brief through the run loop. Line 31 reads outreach_log directly' }));
    expect(findingSignature(f)).not.toBe(findingSignature({ ...f, decision: 'DR-5' }));
    expect(findingSignature({ ...f, files: ['b', 'a'] })).toBe(findingSignature({ ...f, files: ['a', 'b', 'a'] }));
  });

  it('a dismissed finding stays dismissed, including close rephrasings for the same decision and files', () => {
    const d: DismissedFinding[] = [{ signature: findingSignature(f), decision: f.decision, files: f.files, text: f.text }];
    expect(isDismissed(f, d)).toBe(true);
    expect(isDismissed({ ...f, text: 'DR-4 says outreach history reaches the brief through the run loop; this new line reads outreach_log directly.' }, d)).toBe(true);
    expect(isDismissed({ ...f, text: 'The tool caches contact emails in memory, against DR-4.' }, d)).toBe(false);
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
      { decision: 'DR-4', files: [], lines: [{ path: `./${READER}`, line: 3.7 }, { path: 'src/other.ts', line: 2 }, { path: READER, line: -1 }], text: 'Second finding on the cache.', confidence: 'certain' as never },
    ];
    const out = acceptFindings(raw, { decisions: ['DR-4'], files: [READER], dismissed: [], open: [] });
    expect(out).toEqual([
      f,
      { decision: 'DR-4', files: [READER], lines: [{ path: READER, line: 3 }], text: 'Second finding on the cache.', confidence: 'low' },
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
  const created: FileFacts = { path: 'src/tools/contact-history.ts', hash: 'h3', imports: [{ to: 'src/shared/db.ts', typeOnly: false }], writes: [], reads: [{ table: 'outreach_log', symbol: 'src/tools/contact-history.ts#run', via: 'db' }], symbols: [], calls: [{ from: 'src/tools/contact-history.ts#run', to: 'src/shared/db.ts#db.all', confidence: 'syntactic', count: 1 }], routes: [], entries: [] };
  const events: HarnessEvent[] = [
    ev('map_confirmed', { map, source: 'fixture' }),
    ev('repo_scanned', { files: [], imports: [], writes: [], edges: [], fileFacts: Object.values(facts) }),
    ev('turn_started', { prompt: 'add a contact history tool', head: 'HEAD0', baseline: 'SNAP0' }, { turn: 't1' }),
    ev('planned', { steps: [{ n: 1, text: 'history tool', files: ['src/tools/contact-history.ts#run'], imports: [{ from: 'src/tools/contact-history.ts', to: 'src/shared/db.ts' }] }], cells: [], edges: [], unassigned: [] }, { turn: 't1' }),
    ev('edited', { added: 3, removed: 0, created: false, symbols: { ...emptySymbolDiff(), body: ['src/tools/company-profile.ts#companyProfile.run'] } }, { turn: 't1', path: 'src/tools/company-profile.ts' }),
    ev('facts_changed', { facts: after }, { turn: 't1', path: 'src/tools/company-profile.ts' }),
    ev('edited', { added: 9, removed: 0, created: true, symbols: { ...emptySymbolDiff(), added: ['src/tools/contact-history.ts#run'], renamed: [['a#x', 'src/tools/contact-history.ts#y']] } }, { turn: 't1', path: 'src/tools/contact-history.ts' }),
    ev('facts_changed', { facts: created }, { turn: 't1', path: 'src/tools/contact-history.ts' }),
  ];

  it('is null until the turn ends; then files, symbols, baseline and the fact delta come from the log', () => {
    expect(turnSurface(events, 't1')).toBeNull();
    const done = [...events, ev('turn_ended', { added: 12, removed: 0, files: ['src/tools/company-profile.ts', 'src/tools/contact-history.ts', 'domains.yaml', 'scripts/x.ts'], reason: 'success' }, { turn: 't1' })];
    const s = turnSurface(done, 't1')!;
    expect(s).toMatchObject({ turn: 't1', prompt: 'add a contact history tool', baseline: 'SNAP0', source: 'turn' });
    expect(s.files).toEqual(['scripts/x.ts', 'src/tools/company-profile.ts', 'src/tools/contact-history.ts']);
    expect(s.created).toEqual(['src/tools/contact-history.ts']);
    expect(s.symbols).toEqual(['src/tools/company-profile.ts#companyProfile.run', 'src/tools/contact-history.ts#run', 'src/tools/contact-history.ts#y']);
    expect(s.delta).toEqual({
      calls: [
        { from: 'src/tools/company-profile.ts#companyProfile.run', to: 'src/outreach/send.ts#send' },
        { from: 'src/tools/contact-history.ts#run', to: 'src/shared/db.ts#db.all' },
      ],
      imports: [{ from: 'src/tools/company-profile.ts', to: 'src/outreach/send.ts' }, { from: 'src/tools/contact-history.ts', to: 'src/shared/db.ts' }],
      writes: [{ file: 'src/tools/company-profile.ts', table: 'contacts' }],
      reads: [{ file: 'src/tools/contact-history.ts', table: 'outreach_log' }],
    });
    expect(s.plan).toHaveLength(1);
    expect(turnSurface(done, 'nope')).toBeNull();
    expect(factDelta({}, {}, ['x'])).toEqual({ calls: [], imports: [], writes: [], reads: [] });
  });

  it('planSurface reads the latest plan of an open turn', () => {
    const p = planSurface(events, 't1')!;
    expect(p).toMatchObject({ source: 'plan', baseline: null, files: ['src/tools/contact-history.ts'], symbols: ['src/tools/contact-history.ts#run'] });
    expect(p.delta.imports).toEqual([{ from: 'src/tools/contact-history.ts', to: 'src/shared/db.ts' }]);
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
    const rule = amendedRuleText('Research tools never depend on outreach', { id: 'DR-4', title: 'Research tools never read outreach data; the run loop passes outreach context in.' });
    expect(rule).toBe('Research tools never depend on outreach; DR-4: Research tools never read outreach data; the run loop passes outreach context in');
    expect(amendedRuleText(rule, { id: 'DR-4', title: 'Research tools never read outreach data; the run loop passes outreach context in' })).toBe(rule);
    const yaml = setRuleText(mapYaml, 'DR-3', rule);
    const changed = yaml.split('\n').filter((l, i) => l !== mapYaml.split('\n')[i]);
    expect(changed).toEqual([`    rule: ${JSON.stringify(rule)}`]);
    expect(parseDomainMap(yaml).invariants[2]!.rule).toBe(rule);
    expect(() => setRuleText(mapYaml, 'DR-99', 'x')).toThrow(/DR-99/);

    const facts = scoutFacts();
    const p = changeRuleProposal({ id: 'MP-3', yaml: mapYaml, map, facts, history: [], trigger: [], scope: ['src/tools/x.ts', 'rule:DR-3', 'rule:DR-3'], rationale: 'r', invariant: 'DR-3', rule });
    expect(p).toMatchObject({ id: 'MP-3', chosen: 0, scope: ['rule:DR-3', 'src/tools/x.ts'], changes: [{ kind: 'change_rule', invariant: 'DR-3', rule }] });
    expect(p.candidates).toHaveLength(1);
    expect(p.candidates[0]!.yaml).toBe(yaml);
    expect(p.candidates[0]!.score.total).toBe(p.current.total); // rule text doesn't move the map's score

    const m = manualRuleProposal({ id: 'MP-4', yaml: mapYaml, map, facts, history: [], trigger: [], scope: [], rationale: 'r', invariant: 'AF-1', rule: 'DR-9: something' });
    expect(m).toMatchObject({ candidates: [], chosen: 0, changes: [{ kind: 'add_rule', invariant: 'AF-1', rule: 'DR-9: something' }] });
  });
});
