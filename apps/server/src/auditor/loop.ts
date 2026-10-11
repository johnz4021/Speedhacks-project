// The auditor loop (NAVIGATION_PLAN §4.6): after every `turn_ended` (never mid-turn), pre-filter the standing decisions
// against what the turn touched; if any bear on it, run the auditor out of band and emit advisory `audit_finding`s.
// Plan review (D8) runs on each `planned` event only with HARNESS_AUDIT_PLANS=1. Dismiss is remembered; promote and
// rule reinforcement become living-map proposals (`map_proposed { proposal }`). Nothing here touches the ledger.
import { Hono } from 'hono';
import {
  reduce, turnSurface, planSurface, relevantDecisions, acceptFindings, nextFindingId, reinforcements, reinforcementSignal,
  changeRuleProposal, manualRuleProposal, reinforcedRuleText, amendedRuleText, changeSignature, summarizeChanges, historyFromUI, thresholdsFor,
  type AuditFinding, type FileFacts, type MapProposal, type TurnSurface, type UIState,
} from '@harness/core';
import { listDecisions } from '../decisions';
import type { Bus } from '../bus';
import type { Repo } from '../repo';
import { sdkAuditor, type Auditor } from './runner';
import { loadDismissed, rememberDismissed, standingDecisions, turnDiff } from './records';

export type AuditorOptions = {
  bus: Bus;
  repo: Repo;
  auditor?: Auditor | null; // default: the Agent SDK auditor (null when HARNESS_AUDITOR=0)
  plans?: boolean; // review each submitted plan too (default: HARNESS_AUDIT_PLANS=1)
};

export type Result = { ok: true; proposal?: string; manual?: boolean } | { ok: false; status: 400 | 404 | 409; error: string };

const nextProposalId = (ui: UIState) => `MP-${Math.max(0, ...Object.keys(ui.proposals).map((id) => Number(/^MP-(\d+)$/.exec(id)?.[1] ?? 0))) + 1}`;

export function attachAuditor(opts: AuditorOptions) {
  const { bus, repo } = opts;
  const auditor = opts.auditor === undefined ? (process.env.HARNESS_AUDITOR === '0' ? null : sdkAuditor) : opts.auditor;
  const plans = opts.plans ?? process.env.HARNESS_AUDIT_PLANS === '1';
  const work = new Set<Promise<unknown>>();
  let chain: Promise<unknown> = Promise.resolve();
  /** Audits run one at a time, in order, off the emitter's stack. */
  const enqueue = (job: () => Promise<unknown> | unknown) => {
    const p = chain.then(() => new Promise<void>((r) => setImmediate(r))).then(job).catch((e: Error) => {
      bus.emit('error', { message: `Auditor failed: ${e.message}` }, { turn: null });
    });
    chain = p;
    work.add(p);
    void p.finally(() => work.delete(p));
    return p;
  };
  const facts = (): Record<string, FileFacts> => Object.fromEntries(repo.fileFacts);

  /** Pre-filter, then (only if a decision bears on the turn) the model, then accepted findings as events. */
  async function audit(surface: TurnSurface): Promise<{ sent: string[]; findings: AuditFinding[] }> {
    if (!repo.map || !surface.files.length) return { sent: [], findings: [] };
    const relevant = relevantDecisions(standingDecisions(repo.root), repo.map, surface, repo.mapper);
    if (!relevant.length || !auditor) return { sent: relevant.map((r) => r.decision.id), findings: [] };
    const trigger = surface.source;
    const t0 = Date.now();
    let result;
    try {
      result = await auditor({
        root: repo.root,
        surface,
        decisions: relevant,
        invariants: repo.map.invariants,
        diff: surface.source === 'turn' ? turnDiff(repo.root, surface.baseline, surface.files) : '',
      });
    } catch (e) {
      bus.emit('maintenance_run', { agent: 'auditor', trigger, ms: Date.now() - t0, cost: (e as { cost?: number }).cost ?? null, ok: false }, { turn: null });
      bus.emit('error', { message: `Auditor failed: ${(e as Error).message}` }, { turn: null });
      return { sent: relevant.map((r) => r.decision.id), findings: [] };
    }
    const ui = reduce(bus.events);
    const open = Object.values(ui.findings).filter((f) => f.status === 'open');
    const accepted = acceptFindings(result.findings, { decisions: relevant.map((r) => r.decision.id), files: surface.files, dismissed: loadDismissed(repo.root), open });
    const ids = Object.keys(ui.findings);
    const emitted: AuditFinding[] = [];
    for (const f of accepted) {
      const finding: AuditFinding = { id: nextFindingId(ids), ...f };
      ids.push(finding.id);
      bus.emit('audit_finding', { finding }, { turn: surface.turn, path: finding.files[0]! });
      emitted.push(finding);
    }
    bus.emit('maintenance_run', { agent: 'auditor', trigger, ms: Date.now() - t0, cost: result.cost, ok: true }, { turn: null });
    return { sent: relevant.map((r) => r.decision.id), findings: emitted };
  }

  function auditTurn(turnId: string) {
    const s = turnSurface(bus.events, turnId);
    return s ? audit(s) : Promise.resolve({ sent: [], findings: [] });
  }

  function auditPlan(turnId: string) {
    const s = planSurface(bus.events, turnId);
    return s ? audit(s) : Promise.resolve({ sent: [], findings: [] });
  }

  /** Signatures of every rejected map proposal on record, so a rejected rule proposal is never repeated. */
  const rejectedSignatures = () => new Set(listDecisions(repo.root).flatMap((d) => {
    const fm = d as unknown as { status?: string; type?: string; signature?: string };
    return fm.status === 'rejected' && fm.type === 'map_proposal' && fm.signature ? [fm.signature] : [];
  }));

  function emitProposal(proposal: MapProposal, chat: string) {
    bus.emit('map_proposed', { map: repo.map, yaml: repo.mapText, proposal }, { turn: null });
    bus.emit('chat', { role: 'system', text: chat }, { turn: null });
  }

  /** Rule reinforcement (§4.4): option A on the same invariant ≥ N times in one domain → propose stating it as standing. */
  function reinforce(): string[] {
    if (!repo.map || !repo.hasMap()) return [];
    const ui = reduce(bus.events);
    const t = thresholdsFor(repo.map);
    const made: string[] = [];
    const rejected = rejectedSignatures();
    for (const r of reinforcements(ui.decisions, repo.map, t.ruleReinforcement)) {
      const signal = reinforcementSignal(r, t.ruleReinforcement);
      const scopeKey = signal.scope.join('|');
      const seen = Object.values(ui.proposals).some((p) => p.proposal.trigger.some((s) => s.signal === 'rule_reinforcement' && s.scope.join('|') === scopeKey));
      if (seen) continue;
      const inv = repo.map.invariants.find((i) => i.id === r.invariant)!;
      const rule = reinforcedRuleText(inv.rule, r, repo.map.domains.find((d) => d.id === r.domain)?.name ?? r.domain);
      if (rule === inv.rule) continue;
      const proposal = changeRuleProposal({
        id: nextProposalId(reduce(bus.events)), yaml: repo.mapText, map: repo.map, facts: facts(), history: historyFromUI(ui),
        trigger: [signal], scope: [`rule:${r.invariant}`, `domain:${r.domain}`, ...r.paths], invariant: r.invariant, rule,
        rationale: `You chose to comply with ${r.invariant} ${r.decisions.length} times for ${r.domain} (${r.decisions.join(', ')}). Make it a standing rule: the rule text records the confirmations, so the next session reads it as settled.`,
      });
      if (rejected.has(changeSignature(proposal.changes))) continue;
      emitProposal(proposal, `Auditor proposal ${proposal.id} (rule reinforcement): ${summarizeChanges(proposal.changes)}`);
      made.push(proposal.id);
    }
    return made;
  }

  function dismiss(id: string): Result {
    const f = reduce(bus.events).findings[id];
    if (!f) return { ok: false, status: 404, error: `No finding ${id}.` };
    if (f.status !== 'open') return { ok: false, status: 409, error: `${id} is already ${f.status}.` };
    rememberDismissed(repo.root, f);
    bus.emit('audit_resolved', { id, outcome: 'dismissed' }, { turn: null });
    return { ok: true };
  }

  /**
   * Promote a finding into a rule proposal. If its decision is linked to an invariant, the proposal amends that rule's
   * text with the decision (a candidate map, so accept commits it); otherwise it is manual (rule text, no candidate).
   * See packages/core/src/audit/rules.ts for why the three rule kinds rarely express these.
   */
  function promote(id: string): Result {
    const ui = reduce(bus.events);
    const f = ui.findings[id];
    if (!f) return { ok: false, status: 404, error: `No finding ${id}.` };
    if (f.status !== 'open') return { ok: false, status: 409, error: `${id} is already ${f.status}.` };
    if (!repo.map || !repo.hasMap()) return { ok: false, status: 409, error: 'No confirmed map yet.' };
    const decision = f.decision ? standingDecisions(repo.root).find((d) => d.id === f.decision) : undefined;
    const inv = decision?.invariant ? repo.map.invariants.find((i) => i.id === decision.invariant) : undefined;
    const base = {
      id: nextProposalId(ui), yaml: repo.mapText, map: repo.map, facts: facts(), history: historyFromUI(ui), trigger: [],
      scope: [...(inv ? [`rule:${inv.id}`] : []), ...f.files],
    };
    const rule = inv && decision ? amendedRuleText(inv.rule, decision) : null;
    const proposal = inv && rule && rule !== inv.rule
      ? changeRuleProposal({ ...base, invariant: inv.id, rule, rationale: `Promoted from ${id}: ${f.text} The three rule kinds can't check ${decision!.id} directly; accepting states it in ${inv.id}'s rule text, and the auditor keeps checking it.` })
      : manualRuleProposal({ ...base, invariant: id, rule: decision ? `${decision.id}: ${decision.title}` : f.text, rationale: `Promoted from ${id}: ${f.text} No rule kind can express this, so there is no candidate map: write the rule into domains.yaml by hand, or reject.` });
    emitProposal(proposal, `Auditor proposal ${proposal.id} (from ${id}): ${summarizeChanges(proposal.changes)}${proposal.candidates.length ? '' : ' (manual)'}`);
    bus.emit('audit_resolved', { id, outcome: 'promoted' }, { turn: null });
    return { ok: true, proposal: proposal.id, manual: !proposal.candidates.length };
  }

  const off = bus.on((e) => {
    if (e.kind === 'turn_ended' && e.turn) {
      const turn = e.turn;
      enqueue(() => { reinforce(); return auditTurn(turn); });
    } else if (e.kind === 'planned' && plans && e.turn) {
      const turn = e.turn;
      enqueue(() => auditPlan(turn));
    }
  });

  return {
    /** Audit a finished turn now (also runs automatically at every turn end). */
    run(turnId: string) { return enqueue(() => auditTurn(turnId)) as Promise<unknown>; },
    auditTurn,
    auditPlan,
    reinforce,
    dismiss,
    promote,
    /** Resolves once no audit is queued or running (for tests and shutdown). */
    async idle() { while (work.size) await Promise.allSettled([...work]); },
    detach: off,
  };
}

export type AuditorLoop = ReturnType<typeof attachAuditor>;

/** HTTP endpoints, mounted under /api by the server. */
export function auditorRoutes(a: AuditorLoop) {
  const r = new Hono();
  const reply = (c: { json: (b: unknown, s?: 200 | 400 | 404 | 409) => Response }, res: Result) => (res.ok ? c.json(res) : c.json({ error: res.error }, res.status));
  r.post('/findings/:id/dismiss', (c) => reply(c, a.dismiss(c.req.param('id'))));
  r.post('/findings/:id/promote', (c) => reply(c, a.promote(c.req.param('id'))));
  r.post('/audit/turns/:turn', (c) => { void a.run(c.req.param('turn')); return c.json({ ok: true, queued: true }); });
  return r;
}
