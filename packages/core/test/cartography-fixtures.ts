// Shared synthetic inputs for the cartography tests: Scout facts plus a new `src/billing/` folder.
import type { FileFacts } from '../src/contracts/facts';
import type { HarnessEvent } from '../src/events';
import { parseDomainMap } from '../src/schema';
import { mapYaml } from './helpers';
import { scoutFacts } from './scout-facts';

export const ff = (path: string, imports: string[] = [], writes: string[] = []): FileFacts => ({
  path, hash: `h:${path}`, imports: imports.map((to) => ({ to, typeOnly: false })),
  writes: writes.map((table) => ({ table, symbol: null, via: 'db' })), symbols: [], calls: [], routes: [], entries: [],
});

export const BILLING = ['src/billing/charge.ts', 'src/billing/invoice.ts', 'src/billing/refund.ts'];

/** Scout facts + three billing files that import each other and shared/db, two of which write `invoices`. */
export function billingFacts(): Record<string, FileFacts> {
  return {
    ...scoutFacts(),
    'src/billing/invoice.ts': ff('src/billing/invoice.ts', ['src/billing/charge.ts', 'src/shared/db.ts'], ['invoices']),
    'src/billing/charge.ts': ff('src/billing/charge.ts', ['src/shared/db.ts']),
    'src/billing/refund.ts': ff('src/billing/refund.ts', ['src/billing/charge.ts', 'src/billing/invoice.ts', 'src/shared/db.ts'], ['invoices']),
  };
}

export const billingBlock = `
  - id: billing
    name: Billing
    purpose: Invoices, charges and refunds
    cells:
      logic: { paths: ["src/billing/**"], tables: ["invoices"] }
`;

/** Scout's map with a Billing domain added (before the invariants). */
export const billingYaml = mapYaml.replace('\n# Seeded by', `${billingBlock}\n# Seeded by`);
export const billingMap = () => parseDomainMap(billingYaml);

let n = 0;
export const ev = (kind: HarnessEvent['kind'], data: Record<string, unknown>, extra: Partial<HarnessEvent> = {}): HarnessEvent =>
  ({ id: `x${n++}`, t: 9000 + n, session: 's', turn: null, kind, data, ...extra });
