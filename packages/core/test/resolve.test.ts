import { cpSync, existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { fileExistsIn, scanRepoFacts, withExtra } from '../src/facts';
import { resolveImport, resolveSpecifier } from '../src/imports';
import { parseDomainMap } from '../src/schema';

// Copy so the workspace shim (`.harness/ws-modules`, written because the fixture has no node_modules) stays out of the tree.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-alias-')));
cpSync(fileURLToPath(new URL('./alias-repo', import.meta.url)), root, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const exists = fileExistsIn(root);
const r = (from: string, spec: string, ex: (p: string) => boolean = exists) => resolveSpecifier(from, spec, ex);

describe('resolveSpecifier (oxc-resolver over the alias fixture)', () => {
  it('resolves tsconfig paths, including through `extends`, and baseUrl paths', () => {
    expect(r('apps/web/src/main.ts', '@shared/format')).toBe('packages/shared/src/format.ts'); // paths from tsconfig.base.json
    expect(r('apps/api/src/server.ts', '~/handlers')).toBe('apps/api/src/handlers.ts');
  });

  it('resolves workspace packages through package.json exports, and package imports', () => {
    expect(r('apps/web/src/main.ts', '@acme/core')).toBe('packages/core/src/index.ts');
    expect(r('apps/web/src/main.ts', '@acme/core/lib/util')).toBe('packages/core/src/lib/util.ts');
    expect(r('packages/core/src/a.ts', '#internal/util')).toBe('packages/core/src/lib/util.ts');
    expect(existsSync(join(root, '.harness/ws-modules/@acme/core'))).toBe(true); // no node_modules: shimmed under .harness/
  });

  it('maps .js to .ts, and bare packages and builtins to vendor ids', () => {
    expect(r('apps/web/src/main.ts', './z.js')).toBe('apps/web/src/z.ts');
    expect(r('apps/web/src/main.ts', 'react')).toBe('vendor:react');
    expect(r('apps/api/src/server.ts', 'hono/jsx')).toBe('vendor:hono');
    expect(r('apps/web/src/main.ts', 'node:fs')).toBe('vendor:node:fs');
    expect(r('apps/web/src/main.ts', 'fs')).toBe('vendor:node:fs');
    expect(r('apps/api/src/server.ts', '~/missing')).toBeNull(); // an alias that matches nothing is not a package
    expect(resolveImport('apps/web/src/main.ts', 'react', exists)).toBeNull(); // repo files only
  });

  it('resolves planned files (not on disk yet) through relative paths and tsconfig paths', () => {
    const planned = withExtra(exists, ['packages/shared/src/slugify.ts', 'apps/api/src/billing/index.ts']);
    expect(r('apps/web/src/main.ts', '@shared/slugify', planned)).toBe('packages/shared/src/slugify.ts');
    expect(r('apps/api/src/server.ts', '~/billing', planned)).toBe('apps/api/src/billing/index.ts');
    expect(r('apps/api/src/server.ts', './billing', planned)).toBe('apps/api/src/billing/index.ts');
    expect(r('apps/web/src/main.ts', '@shared/slugify')).toBeNull();
  });

  it('scans the repo: imports, calls through workspace barrels, entries and Hono routes', () => {
    const map = parseDomainMap('version: 1\nlayers: [{ id: logic, name: Logic }]\ndomains: []\nignore: [".harness/**", "*.json"]\ninvariants: []\n');
    const { fileFacts } = scanRepoFacts(root, map);
    const main = fileFacts['apps/web/src/main.ts']!;
    expect(main.imports).toEqual(expect.arrayContaining([
      { to: 'packages/core/src/index.ts', typeOnly: false },
      { to: 'packages/core/src/lib/util.ts', typeOnly: false },
      { to: 'packages/shared/src/format.ts', typeOnly: false },
      { to: 'vendor:react', typeOnly: false },
      { to: 'vendor:node:fs', typeOnly: false },
    ]));
    const calls = main.calls.map((c) => `${c.to}${c.count > 1 ? ` x${c.count}` : ''}`).sort();
    expect(calls).toEqual([
      'packages/core/src/lib/more.ts#more', // through `export *`
      'packages/core/src/lib/util.ts#helper x3', // named via barrel, deep import, namespace member
      'packages/shared/src/format.ts#format',
      'vendor:node:fs',
    ]);
    expect(fileFacts['apps/web/src/cli.ts']!.entries.map((e) => e.id).sort()).toEqual(['entry:bin:webcli', 'entry:cli:web:cli']);
    expect(fileFacts['apps/api/src/server.ts']!.routes).toEqual([
      { id: 'route:GET /v1/users/{}', method: 'GET', path: '/v1/users/{}', file: 'apps/api/src/server.ts', handler: 'apps/api/src/handlers.ts#getUser' },
      { id: 'route:POST /v1/users', method: 'POST', path: '/v1/users', file: 'apps/api/src/server.ts', handler: 'apps/api/src/server.ts#<cb1>' },
    ]);
  });
});
