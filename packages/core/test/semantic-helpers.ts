// Shared by the Tier 2 tests: the small TS fixture (test/semantic-repo), a map for it, and temp copies.
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFactsIndex, fileExistsIn, scanRepoFacts, symbolNames } from '../src/facts';
import { settleCalls } from '../src/facts/extract';
import type { FileFacts } from '../src/contracts/facts';
import { parseDomainMap } from '../src/schema';
import { openResolver } from '../src/facts/semantic/open';
import type { ResolverImpl, SemanticResolver } from '../src/facts/semantic/types';

export const semanticRepo = realpathSync(fileURLToPath(new URL('./semantic-repo', import.meta.url)));

/** App (entry: main, logic: registry), Tools, Providers (logic + util as its `external` sink); types.ts is shared. */
export const semanticMap = parseDomainMap(`
version: 1
layers: [{ id: entry, name: Entry }, { id: logic, name: Logic }, { id: external, name: External }]
neutral: ["src/types.ts"]
ignore: ["node_modules/**", "*.json"]
domains:
  - { id: app, name: App, purpose: x, cells: { entry: { paths: ["src/main.ts"] }, logic: { paths: ["src/registry.ts"] } } }
  - { id: tools, name: Tools, purpose: x, cells: { logic: { paths: ["src/tools/**"] } } }
  - { id: providers, name: Providers, purpose: x, cells: { logic: { paths: ["src/providers.ts"] }, external: { paths: ["src/util.ts"] } } }
invariants: []
`);

export function factsOf(root: string): Record<string, FileFacts> {
  return scanRepoFacts(root, semanticMap).fileFacts;
}

/** Tier 1 facts for one file at its current text, calls settled against `all` (as the server's Repo does). */
export function factsFor(root: string, path: string, text: string, all: Record<string, FileFacts>): FileFacts {
  const index = createFactsIndex(root, semanticMap, fileExistsIn(root), (p) => {
    try { return readFileSync(join(root, p), 'utf8'); } catch { return null; }
  });
  const f = index.extract(path, text).facts;
  f.calls = settleCalls(f.calls, symbolNames({ ...all, [path]: f }));
  return f;
}

const tmps: string[] = [];
export function tempCopy(): string {
  const dir = realpathSync(mkdtempSync(join(process.env.HARNESS_TEST_TMP ?? tmpdir(), 'harness-sem-')));
  cpSync(semanticRepo, dir, { recursive: true });
  tmps.push(dir);
  return dir;
}
export const cleanTemps = () => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); };

/** Open a resolver of one kind, or null when it can't load on this platform (the TS 7 test then skips). */
export async function tryOpen(impl: ResolverImpl, root: string, files: readonly string[]): Promise<SemanticResolver | null> {
  try {
    return (await openResolver({ root, files }, impl)).resolver;
  } catch (e) {
    if (impl === 'tsgo') return null;
    throw e;
  }
}
