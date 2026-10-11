// Pick a SemanticResolver: TypeScript 7 (tsgo) first; the TS 6 / ts-morph fallback when TS 7 can't load or start.
import { createTsgoResolver } from './tsgo';
import { createTsMorphResolver } from './tsmorph';
import type { ResolverImpl, ResolverOptions, SemanticResolver } from './types';

export type ResolverChoice = ResolverImpl | 'auto';

export async function openResolver(opts: ResolverOptions, prefer: ResolverChoice = 'auto'): Promise<{ resolver: SemanticResolver; fallback: string | null }> {
  let fallback: string | null = null;
  if (prefer !== 'ts-morph') {
    try {
      return { resolver: await createTsgoResolver(opts), fallback };
    } catch (e) {
      if (prefer === 'tsgo') throw e;
      fallback = `TypeScript 7 unavailable (${(e as Error).message.split('\n')[0]}); using TS 6 via ts-morph`;
    }
  }
  return { resolver: await createTsMorphResolver(opts), fallback };
}
