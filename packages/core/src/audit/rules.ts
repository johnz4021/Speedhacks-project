// Rule proposals from the auditor (NAVIGATION_PLAN §4.4 "Rule reinforcement", §4.6 "promote"). Deterministic, no
// model: they go through the living map's proposal flow (`map_proposed { proposal }`), so accept/reject work the same.
//
// What can be built deterministically, and what can't:
// - The three rule kinds (only_via, owns_writes, no_edge) can't express most rationale-level constraints (e.g. "filings
//   calls pass `redaction: "filings"`"). When the cited decision is linked to an invariant, the proposal amends that
//   invariant's `rule` text with the decision (a `change_rule` with a ready candidate map: accepting commits it, and the
//   rule text then states the constraint wherever the rule is shown). The checker's behaviour is unchanged; the auditor
//   keeps checking the constraint.
// - Otherwise the proposal is manual: an `add_rule` change carrying the rule text and no candidate map. Accept is
//   refused (there is nothing to write); the user writes the rule into domains.yaml by hand, or rejects it.
import YAML, { isMap, isSeq, isScalar } from 'yaml';
import { createMapper } from '../mapper';
import { parseDomainMap, type DomainMap } from '../schema';
import type { Decision } from '../events';
import type { FileFacts } from '../contracts/facts';
import type { DriftSignal, HistoryTurn, MapProposal, ProposalChange } from '../contracts/cartography';
import { DEFAULT_THRESHOLDS } from '../contracts/cartography';
import { domainId } from '../contracts/graph';
import { scoreMap } from '../cartography/score';
import { diffMaps } from '../cartography/diff';

/** Replace invariant `invariantId`'s `rule:` scalar in place (only that value's text changes). */
export function setRuleText(yamlText: string, invariantId: string, rule: string): string {
  const doc = YAML.parseDocument(yamlText);
  const list = doc.get('invariants');
  const inv = isSeq(list) ? list.items.find((item) => isMap(item) && item.get('id') === invariantId) : undefined;
  const node = isMap(inv) ? inv.get('rule', true) : undefined;
  if (!isScalar(node) || !node.range) throw new Error(`domains.yaml has no rule text for ${invariantId}`);
  return yamlText.slice(0, node.range[0]) + JSON.stringify(rule) + yamlText.slice(node.range[1]);
}

/** The same invariant chosen with option A at least `threshold` times for files in the same domain. */
export type Reinforcement = { invariant: string; domain: string; decisions: string[]; paths: string[] };

/** Reinforced invariants from recorded decisions (deduped by id), grouped like the `rule_reinforcement` drift signal. */
export function reinforcements(decisions: readonly Pick<Decision, 'id' | 'invariant' | 'option' | 'paths'>[], map: DomainMap, threshold = DEFAULT_THRESHOLDS.ruleReinforcement): Reinforcement[] {
  const mapper = createMapper(map);
  const groups = new Map<string, Reinforcement>();
  for (const d of new Map(decisions.map((x) => [x.id, x])).values()) {
    if (d.option !== 'A' || !d.invariant) continue;
    const domain = (d.paths[0] && mapper.domainOf(d.paths[0])) ?? 'unassigned';
    const k = `${d.invariant}\u0000${domain}`;
    const g = groups.get(k) ?? { invariant: d.invariant, domain, decisions: [], paths: [] };
    g.decisions.push(d.id);
    g.paths.push(...d.paths);
    groups.set(k, g);
  }
  return [...groups.values()]
    .filter((g) => g.decisions.length >= threshold && map.invariants.some((i) => i.id === g.invariant))
    .map((g) => ({ ...g, paths: [...new Set(g.paths)].sort() }))
    .sort((a, b) => (a.invariant + a.domain < b.invariant + b.domain ? -1 : 1));
}

export type RuleProposalInput = {
  id: string; // MP-n
  yaml: string; // current domains.yaml text
  map: DomainMap;
  facts: Readonly<Record<string, FileFacts>>;
  history: readonly HistoryTurn[];
  trigger: DriftSignal[];
  scope: string[];
  rationale: string;
};

/** A `change_rule` proposal with one candidate: the current map with `invariant`'s rule text replaced by `rule`. */
export function changeRuleProposal(input: RuleProposalInput & { invariant: string; rule: string }): MapProposal {
  const yaml = setRuleText(input.yaml, input.invariant, input.rule);
  const next = parseDomainMap(yaml);
  const files = Object.keys(input.facts);
  const current = scoreMap(input.map, input.facts, input.history, { current: input.map });
  const score = scoreMap(next, input.facts, input.history, { current: input.map });
  const changes = diffMaps(input.map, next, files);
  return { id: input.id, trigger: input.trigger, scope: [...new Set(input.scope)].sort(), candidates: [{ yaml, score }], chosen: 0, current, changes, rationale: input.rationale };
}

/** A manual `add_rule` proposal: the rule text only, no candidate map (accept is refused; see the module comment). */
export function manualRuleProposal(input: RuleProposalInput & { invariant: string; rule: string }): MapProposal {
  const current = scoreMap(input.map, input.facts, input.history, { current: input.map });
  const changes: ProposalChange[] = [{ kind: 'add_rule', invariant: input.invariant, rule: input.rule }];
  return { id: input.id, trigger: input.trigger, scope: [...new Set(input.scope)].sort(), candidates: [], chosen: 0, current, changes, rationale: input.rationale };
}

/** Rule text for a reinforced invariant: the rule, plus the decisions that confirmed it. */
export function reinforcedRuleText(rule: string, r: Reinforcement, domainName: string): string {
  return `${stripClause(rule)} (confirmed ${r.decisions.length}× for ${domainName}: ${r.decisions.join(', ')})`;
}

/** Rule text that also states a decision's constraint: `<rule>; <decision id>: <title>`. */
export function amendedRuleText(rule: string, decision: { id: string; title: string }): string {
  const clause = `${decision.id}: ${decision.title.replace(/[.\s]+$/, '')}`;
  return rule.includes(clause) ? rule : `${rule.replace(/[.\s]+$/, '')}; ${clause}`;
}

const stripClause = (rule: string) => rule.replace(/\s*\(confirmed \d+× for [^)]*\)\s*$/, '');

/** The drift-style trigger for a reinforcement proposal (scope `rule:<id>` + the domain). */
export function reinforcementSignal(r: Reinforcement, threshold = DEFAULT_THRESHOLDS.ruleReinforcement): DriftSignal {
  return { signal: 'rule_reinforcement', metric: `option A chosen for ${r.invariant} in ${r.domain}`, value: r.decisions.length, threshold, scope: [`rule:${r.invariant}`, domainId(r.domain)], persisted: 1 };
}
