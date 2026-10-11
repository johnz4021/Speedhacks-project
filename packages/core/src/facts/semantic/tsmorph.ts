// SemanticResolver fallback: the TS 6 compiler bundled with ts-morph. Stable API, slower to open and heavier on memory
// than tsgo; chosen automatically when TypeScript 7 can't load on this platform.
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Project, SourceFile, ts as TS } from 'ts-morph';
import { isAbstract, kindTable, packageOf, qualifiedName, type DeclNode } from './names';
import type { DeclInfo, ResolverOptions, SemanticResolver } from './types';

const posix = (p: string) => p.split(sep).join('/');

export async function createTsMorphResolver({ root, files }: ResolverOptions): Promise<SemanticResolver> {
  const { Project: ProjectCtor, ts } = await import('ts-morph');
  const kindOf = kindTable(ts.SyntaxKind as unknown as Record<string, unknown>);
  const abs = (rel: string) => join(root, rel);
  const tsconfig = join(root, 'tsconfig.json');
  const project: Project = existsSync(tsconfig)
    ? new ProjectCtor({ tsConfigFilePath: tsconfig })
    : new ProjectCtor({
        compilerOptions: {
          allowJs: true, checkJs: false, jsx: ts.JsxEmit.Preserve, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
          moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true, noEmit: true, esModuleInterop: true, resolveJsonModule: true,
        },
      });
  if (!existsSync(tsconfig)) for (const f of files) project.addSourceFileAtPathIfExists(abs(f));

  let program: TS.Program | null = null;
  let checker: TS.TypeChecker | null = null;
  const decls = new Map<TS.Node, DeclInfo>();
  const current = () => {
    if (!program) {
      program = project.getProgram().compilerObject;
      checker = program.getTypeChecker();
      decls.clear();
    }
    return { program, checker: checker! };
  };

  /** Innermost node containing `pos` (positions point at identifiers, never into trivia). */
  const nodeAt = (sf: TS.SourceFile, pos: number) => {
    let n: TS.Node = sf;
    for (;;) {
      const c: TS.Node | undefined = ts.forEachChild(n, (ch) => (ch.pos <= pos && pos < ch.end ? ch : undefined));
      if (!c) return n;
      n = c;
    }
  };

  const classify = (d: TS.Declaration): DeclInfo => {
    let info = decls.get(d);
    if (info) return info;
    const fileName = d.getSourceFile().fileName;
    const pkg = packageOf(fileName);
    const rel = posix(relative(root, fileName));
    if (fileName.includes('/node_modules/')) info = pkg ? { where: 'package', pkg } : { where: 'lib' };
    else if (!rel || rel.startsWith('..')) info = { where: 'lib' };
    else info = { where: 'repo', file: rel, name: qualifiedName(d as unknown as DeclNode, kindOf), abstract: isAbstract(d as unknown as DeclNode, kindOf) };
    decls.set(d, info);
    return info;
  };

  const sourceFile = (rel: string): SourceFile | undefined => project.getSourceFile(abs(rel)) ?? (() => {
    const sf = project.addSourceFileAtPathIfExists(abs(rel));
    if (sf) program = null;
    return sf;
  })();

  return {
    impl: 'ts-morph',
    declarationsAt(file, positions) {
      if (!positions.length) return [];
      if (!sourceFile(file)) return positions.map(() => null);
      const { program: p, checker: c } = current();
      const sf = p.getSourceFile(abs(file));
      if (!sf) return positions.map(() => null);
      return positions.map((pos) => {
        try {
          let s = c.getSymbolAtLocation(nodeAt(sf, pos));
          if (s && s.flags & ts.SymbolFlags.Alias) s = c.getAliasedSymbol(s);
          const d = s?.declarations?.[0] ?? s?.valueDeclaration;
          return d ? classify(d) : null;
        } catch {
          return null;
        }
      });
    },
    update({ changed, created, deleted }) {
      for (const f of changed) project.getSourceFile(abs(f))?.refreshFromFileSystemSync();
      for (const f of created) project.addSourceFileAtPathIfExists(abs(f));
      for (const f of deleted) {
        const sf = project.getSourceFile(abs(f));
        if (sf) project.removeSourceFile(sf);
      }
      if (changed.length || created.length || deleted.length) program = null;
    },
    close() {
      program = null;
      checker = null;
      decls.clear();
    },
  };
}
