// Entry points from package.json: `bin`, `main`, and `scripts` that run a source file. Node-only (reads files).
import * as fs from 'node:fs';
import { normalizePath, resolvePath } from '../imports';
import type { PackageEntry } from './extract';
import { workspaceDirs } from './resolver';

const RUNNERS = new Set(['node', 'tsx', 'ts-node', 'ts-node-esm', 'bun', 'deno', 'esno', 'esrun', 'vite-node', 'nodemon', 'jiti', 'sucrase-node', 'babel-node']);
const CODE = /\.[cm]?[jt]sx?$/;

type Pkg = { name?: string; bin?: string | Record<string, string>; main?: string; scripts?: Record<string, string> };

/** package.json entries (root and workspace packages) keyed by the repo file they run. */
export function packageEntries(root: string, exists: (path: string) => boolean): Map<string, PackageEntry[]> {
  const out = new Map<string, PackageEntry[]>();
  for (const dir of ['', ...workspaceDirs(root)]) {
    let pkg: Pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(`${root}/${dir ? `${dir}/` : ''}package.json`, 'utf8')) as Pkg;
    } catch {
      continue;
    }
    const target = (file: string): string | null => {
      const p = normalizePath(dir ? `${dir}/${file}` : file);
      if (!p) return null;
      // Built outputs (`dist/cli.js`) usually come from `src/cli.ts`.
      return resolvePath(p, exists) ?? resolvePath(p.replace(/(^|\/)(?:dist|build|lib|out)\//, '$1src/'), exists);
    };
    const add = (file: string | undefined, entry: PackageEntry) => {
      const t = file ? target(file) : null;
      if (!t) return;
      const list = out.get(t) ?? [];
      if (!list.some((e) => e.kind === entry.kind && e.label === entry.label)) list.push(entry);
      out.set(t, list);
    };
    const name = pkg.name ?? (dir || 'root');
    if (typeof pkg.bin === 'string') add(pkg.bin, { kind: 'bin', label: name.replace(/^@[^/]+\//, '') });
    else for (const [bin, file] of Object.entries(pkg.bin ?? {})) add(file, { kind: 'bin', label: bin });
    if (pkg.main) add(pkg.main, { kind: 'main', label: name });
    for (const [script, cmd] of Object.entries(pkg.scripts ?? {})) {
      const label = dir ? `${name}:${script}` : script;
      for (const part of cmd.split(/&&|\|\||[;|&]/)) {
        const tokens = part.trim().split(/\s+/).filter((t) => !/^\w+=/.test(t)); // drop `FOO=1` env prefixes
        const runner = tokens[0]?.replace(/^npx$/, '') || tokens[1];
        if (!runner || !RUNNERS.has(runner)) continue;
        const file = tokens.find((t) => !t.startsWith('-') && CODE.test(t));
        if (file) add(file, { kind: 'script', label });
      }
    }
  }
  return out;
}
