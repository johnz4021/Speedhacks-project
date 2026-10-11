import { z } from 'zod';
import YAML from 'yaml';

const LayerSchema = z.object({ id: z.string(), name: z.string() });

/** A confirmed sub-group inside a cell (promoted from an inferred cartographer label). */
const ComponentSchema = z.object({ id: z.string(), name: z.string(), paths: z.array(z.string()) });

const CellSchema = z.object({
  paths: z.array(z.string()).optional(),
  tables: z.array(z.string()).optional(),
  components: z.array(ComponentSchema).optional(),
});

/** Living-map settings (NAVIGATION_PLAN §4.4). Missing thresholds fall back to DEFAULT_THRESHOLDS. */
const CartographySchema = z.object({
  thresholds: z.record(z.string(), z.number()).optional(),
  /**
   * Custom router patterns: `pattern` is a JS regex source matched against `file`'s text, with named groups
   * `method` and `path` (or groups 1 and 2); the handler is the first symbol defined after the match.
   */
  routes: z.array(z.object({ file: z.string(), pattern: z.string() })).optional(),
});

const DomainSchema = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.string(),
  cells: z.record(z.string(), CellSchema),
  tests: z.array(z.string()).optional(),
});

/** An exception may be written as a bare path string; it is normalized to `{ path }`. */
const ExceptionSchema = z.union([
  z.string().transform((path): { path: string; decision?: string } => ({ path })),
  z.object({ path: z.string(), decision: z.string().optional() }),
]);

const InvariantBase = z.object({
  id: z.string(),
  rule: z.string(),
  exceptions: z.array(ExceptionSchema).default([]),
  source: z.string().optional(),
  /** Decision records (DR ids) that confirmed this invariant. */
  decisions: z.array(z.string()).optional(),
});

const InvariantSchema = z.discriminatedUnion('kind', [
  InvariantBase.extend({
    kind: z.literal('only_via'),
    targets: z.array(z.string()),
    allowed_from: z.array(z.string()),
  }),
  InvariantBase.extend({
    kind: z.literal('owns_writes'),
    owners: z.record(z.string(), z.string()),
  }),
  InvariantBase.extend({
    kind: z.literal('no_edge'),
    from: z.string(),
    to: z.string(),
  }),
]);

/** Schema for a target repo's `domains.yaml`. */
export const DomainMapSchema = z
  .object({
    version: z.number(),
    layers: z.array(LayerSchema),
    neutral: z.array(z.string()).optional(),
    ignore: z.array(z.string()).optional(),
    domains: z.array(DomainSchema),
    invariants: z.array(InvariantSchema).default([]),
    cartography: CartographySchema.optional(),
  })
  .superRefine((map, ctx) => {
    const layers = new Set(map.layers.map((l) => l.id));
    const domains = new Set(map.domains.map((d) => d.id));
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    map.domains.forEach((d, i) => {
      for (const layer of Object.keys(d.cells)) {
        if (!layers.has(layer)) issue(['domains', i, 'cells', layer], `unknown layer "${layer}"`);
      }
    });
    map.invariants.forEach((inv, i) => {
      const refs =
        inv.kind === 'only_via' ? inv.allowed_from : inv.kind === 'owns_writes' ? Object.values(inv.owners) : [inv.from, inv.to];
      for (const ref of refs) {
        if (!domains.has(ref)) issue(['invariants', i], `${inv.id} refers to unknown domain "${ref}"`);
      }
    });
  });

export type DomainMap = z.output<typeof DomainMapSchema>;
export type Layer = DomainMap['layers'][number];
export type Domain = DomainMap['domains'][number];
export type Invariant = DomainMap['invariants'][number];
export type InvariantException = Invariant['exceptions'][number];

/** Parse and validate `domains.yaml` text. Throws an Error with a readable message. */
export function parseDomainMap(yamlText: string): DomainMap {
  let raw: unknown;
  try {
    raw = YAML.parse(yamlText);
  } catch (err) {
    throw new Error(`domains.yaml is not valid YAML: ${(err as Error).message}`);
  }
  const result = DomainMapSchema.safeParse(raw);
  if (!result.success) throw new Error(`domains.yaml is invalid:\n${z.prettifyError(result.error)}`);
  return result.data;
}
