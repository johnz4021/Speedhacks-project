// Beat 4 (DEMO_PLAN): decisions protect the code that implements them. The rule (protectsFor), plan and edit
// matching (stepTouches, editTouches), and the reminder text. Pure; against the reference map.
import { describe, expect, it } from 'vitest';
import { createMapper } from '../src/mapper';
import { editTouches, protectsFor, protectsSummary, stepTouches, touchText, type Protects, type TurnPath } from '../src/protects';
import type { SymbolDiff } from '../src/contracts/facts';
import { loadMap } from './helpers';

const mapper = createMapper(loadMap());
const diff = (d: Partial<SymbolDiff>): SymbolDiff => ({ added: [], removed: [], sig: [], body: [], renamed: [], ...d });
const at = (symbols: Partial<SymbolDiff> | null, extra: Partial<TurnPath> = {}): TurnPath => ({ edits: 1, created: false, symbols: symbols ? diff(symbols) : null, ...extra });

// Beat 3 on Scout, as the turn's leaf activity: the 10-K tool (the file that forked on DR-1) goes through the gateway,
// which gains a filing mode; the tool is registered; the gateway test covers the filing mode.
const BEAT3: Record<string, TurnPath> = {
  'src/tools/filing-summarize.ts': at({ added: ['src/tools/filing-summarize.ts#filingSummarize', 'src/tools/filing-summarize.ts#filingSummarize.run'] }, { created: true }),
  'src/tools/index.ts': at({ body: ['src/tools/index.ts#TOOLS'] }),
  'src/gateway/redact.ts': at({
    added: ['src/gateway/redact.ts#RedactionMode'],
    sig: ['src/gateway/redact.ts#redactMessages'],
    body: ['src/gateway/redact.ts#Redactor', 'src/gateway/redact.ts#Redactor.redact', 'src/gateway/redact.ts#Redactor.<cb1>'],
  }),
  'src/gateway/complete.ts': at({ sig: ['src/gateway/complete.ts#complete'], body: ['src/gateway/complete.ts#PURPOSES'], removed: ['src/gateway/complete.ts#OLD'] }),
  'test/gateway/redact.test.ts': at({ added: ['test/gateway/redact.test.ts#<cb3>'] }),
  'decisions/DR-4.md': at(null),
  'src/gateway/schema.sql': at(null, { edits: 0, }), // only looked at
};
const DR4 = { paths: ['src/tools/filing-summarize.ts'], option: 'A' as const };

describe('protectsFor', () => {
  it("on Scout's beat 3: the gateway's filing-mode symbols and the gateway test; not the tool, its registry, or DR files", () => {
    expect(protectsFor(BEAT3, DR4, mapper)).toEqual({
      paths: ['src/gateway/complete.ts', 'src/gateway/redact.ts', 'test/gateway/redact.test.ts'],
      symbols: [
        'src/gateway/complete.ts#PURPOSES', 'src/gateway/complete.ts#complete',
        'src/gateway/redact.ts#RedactionMode', 'src/gateway/redact.ts#Redactor', 'src/gateway/redact.ts#Redactor.redact', 'src/gateway/redact.ts#redactMessages',
      ],
    });
  });

  it('keeps the violating domain when the fix lives there too (only the violating files drop)', () => {
    const paths = { 'src/tools/x.ts': at({ added: ['src/tools/x.ts#x'] }), 'src/tools/shared-client.ts': at({ body: ['src/tools/shared-client.ts#client'] }) };
    expect(protectsFor(paths, { paths: ['src/tools/x.ts'], option: 'A' }, mapper)).toEqual({ paths: ['src/tools/shared-client.ts'], symbols: ['src/tools/shared-client.ts#client'] });
  });

  it('option B protects the excepted file (and tests); a file with no symbol changes is protected whole', () => {
    const paths = { 'src/tools/news-summarize.ts': at({ body: ['src/tools/news-summarize.ts#newsSummarize.run'] }), 'src/gateway/redact.ts': at({ body: ['src/gateway/redact.ts#Redactor'] }), 'src/orchestrator/schema.sql': at(null) };
    expect(protectsFor(paths, { paths: ['src/tools/news-summarize.ts'], option: 'B' }, mapper)).toEqual({ paths: ['src/tools/news-summarize.ts'], symbols: ['src/tools/news-summarize.ts#newsSummarize.run'] });
    expect(protectsFor({ 'src/orchestrator/schema.sql': at(null) }, { paths: ['src/tools/a.ts'], option: 'A' }, mapper)).toEqual({ paths: ['src/orchestrator/schema.sql'], symbols: [] });
  });

  it('is empty when the turn built nothing', () => {
    expect(protectsFor({}, DR4, mapper)).toEqual({ paths: [], symbols: [] });
  });
});

const P: Protects = protectsFor(BEAT3, DR4, mapper);
const step = (files: string[], symbols?: string[], imports: { from: string; to: string }[] = []) => ({ files, imports, ...(symbols ? { symbols } : {}) });

describe('stepTouches (plans)', () => {
  it('a step editing a protected file without naming symbols touches every protected symbol there (beat 4\'s widening)', () => {
    expect(stepTouches(P, step(['src/gateway/redact.ts']))).toEqual({
      paths: ['src/gateway/redact.ts'],
      symbols: ['src/gateway/redact.ts#RedactionMode', 'src/gateway/redact.ts#Redactor', 'src/gateway/redact.ts#Redactor.redact', 'src/gateway/redact.ts#redactMessages'],
    });
  });

  it('naming a protected symbol, one inside it, or its container touches it; naming only other symbols there does not', () => {
    expect(stepTouches(P, step(['src/gateway/redact.ts'], ['src/gateway/redact.ts#Redactor.token']))).toEqual({ paths: ['src/gateway/redact.ts'], symbols: ['src/gateway/redact.ts#Redactor'] });
    expect(stepTouches(P, step([], ['src/gateway/complete.ts#complete']))).toEqual({ paths: ['src/gateway/complete.ts'], symbols: ['src/gateway/complete.ts#complete'] });
    expect(stepTouches(P, step(['src/gateway/redact.ts'], ['src/gateway/redact.ts#EMAIL_PATTERN']))).toBeNull();
  });

  it('a whole-file protection (the test) is touched by listing it, naming a symbol in it, or importing from it', () => {
    expect(stepTouches(P, step(['test/gateway/redact.test.ts']))).toEqual({ paths: ['test/gateway/redact.test.ts'], symbols: [] });
    expect(stepTouches(P, step([], ['test/gateway/redact.test.ts#<cb1>']))).toEqual({ paths: ['test/gateway/redact.test.ts'], symbols: [] });
    expect(stepTouches(P, step([], undefined, [{ from: 'test/gateway/redact.test.ts', to: 'src/x.ts' }]))?.paths).toEqual(['test/gateway/redact.test.ts']);
  });

  it('unrelated steps touch nothing', () => {
    expect(stepTouches(P, step(['src/tools/earnings.ts', 'src/tools/index.ts'], ['src/tools/index.ts#TOOLS']))).toBeNull();
  });
});

describe('editTouches (edits)', () => {
  it('a body or signature change, removal or rename of a protected symbol touches it; added symbols do not', () => {
    expect(editTouches(P, 'src/gateway/redact.ts', diff({ body: ['src/gateway/redact.ts#Redactor.redact', 'src/gateway/redact.ts#Redactor'] })))
      .toEqual({ paths: ['src/gateway/redact.ts'], symbols: ['src/gateway/redact.ts#Redactor', 'src/gateway/redact.ts#Redactor.redact'] });
    expect(editTouches(P, 'src/gateway/complete.ts', diff({ renamed: [['src/gateway/complete.ts#complete', 'src/gateway/complete.ts#completeText']] }))?.symbols).toEqual(['src/gateway/complete.ts#complete']);
    expect(editTouches(P, 'src/gateway/redact.ts', diff({ removed: ['src/gateway/redact.ts#RedactionMode'] }))?.symbols).toEqual(['src/gateway/redact.ts#RedactionMode']);
    expect(editTouches(P, 'src/gateway/redact.ts', diff({ added: ['src/gateway/redact.ts#LONG_NUMBER'] }))).toBeNull();
    expect(editTouches(P, 'src/gateway/redact.ts', diff({ body: ['src/gateway/redact.ts#PHONE_PATTERN'] }))).toBeNull();
  });

  it('a change outside every symbol (a shared module-level pattern) touches all protected symbols in that file', () => {
    expect(editTouches(P, 'src/gateway/redact.ts', diff({}), true)).toEqual({
      paths: ['src/gateway/redact.ts'],
      symbols: ['src/gateway/redact.ts#RedactionMode', 'src/gateway/redact.ts#Redactor', 'src/gateway/redact.ts#Redactor.redact', 'src/gateway/redact.ts#redactMessages'],
    });
    expect(editTouches(P, 'src/tools/index.ts', diff({}), true)).toBeNull();
  });

  it('any change to a file protected whole touches it, even without a symbol diff; other files never do', () => {
    expect(editTouches(P, 'test/gateway/redact.test.ts', null)).toEqual({ paths: ['test/gateway/redact.test.ts'], symbols: [] });
    expect(editTouches(P, 'src/gateway/redact.ts', null)).toBeNull();
    expect(editTouches(P, 'src/tools/index.ts', diff({ body: ['src/tools/index.ts#TOOLS'] }))).toBeNull();
  });
});

describe('reminder text', () => {
  it('names the decision, its principle and outcome, the session, and what to do; not a block', () => {
    const t = stepTouches(P, step(['src/gateway/redact.ts'], ['src/gateway/redact.ts#Redactor.redact']))!;
    expect(touchText({ id: 'DR-4', title: 'Filings go through the gateway, in a filing mode that keeps figures intact', outcome: 'Route it through the Model gateway instead of importing vendor/llm-anthropic/index.ts directly.', session: 1 }, t, 'plan'))
      .toBe('This plan touches what DR-4 protects: Filings go through the gateway, in a filing mode that keeps figures intact. Route it through the Model gateway instead of importing vendor/llm-anthropic/index.ts directly. Keep it true (decided in session 1): scope the change so it still holds, and extend its test. Protected code here: src/gateway/redact.ts#Redactor, src/gateway/redact.ts#Redactor.redact.');
    expect(touchText({ id: 'DR-4', title: 'T', outcome: 'O', session: null }, { paths: ['test/gateway/redact.test.ts'], symbols: [] }, 'edit'))
      .toBe('This edit touches what DR-4 protects: T. O. Keep it true: scope the change so it still holds, and extend its test. Protected code here: test/gateway/redact.test.ts.');
  });

  it('summarizes protected code per file', () => {
    expect(protectsSummary(P)).toBe('src/gateway/complete.ts#PURPOSES, complete; src/gateway/redact.ts#RedactionMode, Redactor, Redactor.redact, redactMessages; test/gateway/redact.test.ts');
  });
});
