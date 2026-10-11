import { describe, expect, it } from 'vitest';
import { parseImports, resolveImport, stripComments } from '../src/imports';

describe('parseImports', () => {
  it('reads every import syntax in source order', () => {
    const src = [
      `import a from "./a";`,
      `import type { T } from './types';`,
      `import {`,
      `  b,`,
      `  c as d,`,
      `} from "../b";`,
      `import * as ns from './ns';`,
      `import x, { y } from './xy';`,
      `import './side-effect';`,
      `export { e } from "./e";`,
      `export * from './star';`,
      `export type { F } from './f';`,
      `const m = await import('./dynamic');`,
      'const t = await import(`./tpl`);',
      `import { readFile } from "node:fs";`,
      `import { z } from 'zod';`,
    ].join('\n');
    expect(parseImports(src)).toEqual([
      './a', './types', '../b', './ns', './xy', './side-effect', './e', './star', './f', './dynamic', './tpl', 'node:fs', 'zod',
    ]);
  });

  it('ignores commented-out imports, but not strings that contain //', () => {
    const src = [
      `// import { chat } from "../../vendor/llm-openai/index";`,
      `/* import x from './block';`,
      `   import y from './block2'; */`,
      `const url = "https://example.com/x"; import { ok } from './ok';`,
      `const re = /\\/\\/ not a comment/; import './after-regex';`,
      'const tpl = `// ${"x" + `${1}`} still a string`; import "./after-template";',
      `const notDynamic = foo.import('./nope');`,
      `const computed = import(\`./\${name}\`);`,
    ].join('\n');
    expect(parseImports(src)).toEqual(['./ok', './after-regex', './after-template']);
  });

  it('keeps offsets and newlines when stripping comments', () => {
    const src = 'a // x\n/* y\nz */ b';
    const out = stripComments(src);
    expect(out).toHaveLength(src.length);
    expect(out.split('\n')).toHaveLength(3);
    expect(out.trim().replace(/\s+/g, ' ')).toBe('a b');
  });
});

describe('resolveImport', () => {
  const files = new Set([
    'src/gateway/complete.ts',
    'src/tools/index.ts',
    'src/ui/App.tsx',
    'src/ui/widgets/index.tsx',
    'src/esm/mod.mts',
    'src/plain.js',
    'vendor/llm-openai/index.ts',
  ]);
  const exists = (p: string) => files.has(p);

  it('tries as written, then .ts, .tsx, /index.ts, /index.tsx', () => {
    expect(resolveImport('src/tools/a.ts', '../gateway/complete', exists)).toBe('src/gateway/complete.ts');
    expect(resolveImport('src/tools/a.ts', '../gateway/complete.ts', exists)).toBe('src/gateway/complete.ts');
    expect(resolveImport('src/main.ts', './ui/App', exists)).toBe('src/ui/App.tsx');
    expect(resolveImport('src/orchestrator/r.ts', '../tools', exists)).toBe('src/tools/index.ts');
    expect(resolveImport('src/ui/App.tsx', './widgets', exists)).toBe('src/ui/widgets/index.tsx');
    expect(resolveImport('src/tools/x/y.ts', '../../../vendor/llm-openai/index', exists)).toBe('vendor/llm-openai/index.ts');
    expect(resolveImport('src/main.ts', './plain.js', exists)).toBe('src/plain.js');
  });

  it('maps .js/.jsx/.mjs specifiers to .ts/.tsx/.mts', () => {
    expect(resolveImport('src/tools/a.ts', '../gateway/complete.js', exists)).toBe('src/gateway/complete.ts');
    expect(resolveImport('src/main.ts', './ui/App.js', exists)).toBe('src/ui/App.tsx');
    expect(resolveImport('src/main.ts', './ui/App.jsx', exists)).toBe('src/ui/App.tsx');
    expect(resolveImport('src/main.ts', './esm/mod.mjs', exists)).toBe('src/esm/mod.mts');
  });

  it('ignores bare and node: specifiers, missing files and paths above the root', () => {
    expect(resolveImport('src/a.ts', 'zod', exists)).toBeNull();
    expect(resolveImport('src/a.ts', 'node:fs', exists)).toBeNull();
    expect(resolveImport('src/a.ts', './missing', exists)).toBeNull();
    expect(resolveImport('src/a.ts', '../../outside', exists)).toBeNull();
  });
});
