import type { FactDelta } from './facts';
import { createMapper, matchesAny, type Mapper } from './mapper';
import type { DomainMap, Invariant } from './schema';

export type Violation = {
  invariant: string;
  kind: Invariant['kind'];
  /** One plain sentence naming the file and the rule. */
  reason: string;
  file: string;
  /** Short fact, e.g. `src/a.ts → vendor/b/index.ts` or `src/a.ts writes "runs"`. */
  detail: string;
  /** [A: comply, B: add an exception and record why]. */
  options: [string, string];
  /** Imported file or written table. */
  target?: string;
  /** Latest decision linked to the invariant, if any. */
  decision?: string;
};

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * THE invariant checker: the violations a set of added imports and writes would cause.
 * Used on load (whole-repo facts), on `submit_plan`, and in the edit hook.
 * Ignored files never violate; neutral files have no domain, so they are exempt from
 * `only_via` and `no_edge` but still bound by `owns_writes`. Test files are bound by import rules only.
 */
export function check(map: DomainMap, delta: FactDelta, mapper: Mapper = createMapper(map)): Violation[] {
  const domainName = (id: string) => map.domains.find((d) => d.id === id)?.name ?? id;
  const found = new Map<string, Violation>();

  const add = (inv: Invariant, file: string, target: string, fact: string, detail: string, optionA: string) => {
    if (inv.exceptions.some((e) => matchesAny([e.path], file))) return;
    const decision = inv.decisions?.at(-1);
    const v: Violation = {
      invariant: inv.id,
      kind: inv.kind,
      reason: `${decision ? `You decided this in ${decision}. ` : ''}${file} ${fact}, but ${inv.id}: ${inv.rule}.`,
      file,
      detail,
      options: [optionA, `Add an exception for ${file} and record why`],
      target,
      ...(decision ? { decision } : {}),
    };
    found.set(`${inv.id}\u0000${file}\u0000${target}`, v);
  };

  for (const inv of map.invariants) {
    if (inv.kind === 'owns_writes') {
      for (const w of delta.writes) {
        const owner = inv.owners[w.table];
        // Test files seed fixture rows; that is setup, not a product write.
        if (!owner || mapper.isIgnored(w.file) || mapper.place(w.file).kind === 'test' || mapper.domainOf(w.file) === owner) continue;
        add(inv, w.file, w.table, `writes "${w.table}"`, `${w.file} writes "${w.table}"`,
          `Ask the ${domainName(owner)} domain to write ${w.table} (call its function) instead of writing it here`);
      }
      continue;
    }
    for (const imp of delta.imports) {
      const p = mapper.place(imp.from);
      if (p.kind === 'ignored' || p.kind === 'neutral') continue;
      const from = mapper.domainOf(imp.from);
      const fact = `imports ${imp.to}`;
      const detail = `${imp.from} → ${imp.to}`;
      if (inv.kind === 'only_via') {
        if (!matchesAny(inv.targets, imp.to) || (from !== null && inv.allowed_from.includes(from))) continue;
        add(inv, imp.from, imp.to, fact, detail, onlyViaOption(map, inv.allowed_from, imp.to));
      } else if (from === inv.from && mapper.domainOf(imp.to) === inv.to) {
        add(inv, imp.from, imp.to, fact, detail, `Remove the dependency from ${domainName(inv.from)} on ${domainName(inv.to)}`);
      }
    }
  }

  return [...found.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.invariant.localeCompare(b.invariant) || (a.target ?? '').localeCompare(b.target ?? ''),
  );
}

function onlyViaOption(map: DomainMap, allowed: string[], target: string): string {
  const domains = allowed.flatMap((id) => map.domains.filter((d) => d.id === id));
  const only = domains.length === 1 ? domains[0] : undefined;
  if (only) return `Route it through the ${only.name} (${lowerFirst(only.purpose)}) instead of importing ${target} directly`;
  if (domains.length === 0) return `Remove the import of ${target}`;
  return `Route it through the ${domains.map((d) => d.name).join(' or ')} domain instead of importing ${target} directly`;
}
