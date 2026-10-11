// UI → API links for journeys (NAVIGATION_PLAN §2 "Journeys"): `fetch` call sites (direct, through a small wrapper
// such as Scout's `request(path)`, or axios/ky) with their URL literal, matched to route facts. Pure and browser-safe:
// it scans source text, using the file's symbol spans only to name the enclosing symbol.
import type { RouteFact, SymbolFact } from '../contracts/facts';

/** A call that sends an HTTP request to a URL known (at least in part) from the source text. */
export type FetchSite = {
  file: string;
  from: string; // enclosing symbol id, or the file path for top-level code
  method: string; // upper case; GET when the call doesn't say
  url: string; // path only, query dropped, `${…}` → `{}`
  exact: boolean; // the whole URL is literal text at the call (no template holes, no wrapper prefix)
  via: string | null; // wrapper or client the call goes through (`request`, `axios.post`), null for a direct fetch
};

export type SourceFile = { path: string; source: string; symbols: readonly SymbolFact[] };

const CLIENT = /(?<![\w$.])(?:(fetch|\$fetch|ofetch)|(axios|ky)\s*\.\s*(get|post|put|patch|delete|head|options))\s*(?:<[^()]*?>)?\s*\(/g;
const QUOTES = new Set(['"', "'", '`']);

/** Read a string or template literal starting at `i` (the quote). Template holes become `{}`; `holes` counts them. */
function readString(src: string, i: number): { value: string; end: number; holes: number; tail: string } | null {
  const q = src[i];
  if (!q || !QUOTES.has(q)) return null;
  let value = '';
  let holes = 0;
  let tail = ''; // literal text after the last hole
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j]!;
    if (c === '\\') { value += src[j + 1] ?? ''; tail += src[j + 1] ?? ''; j++; continue; }
    if (c === q) return { value, end: j + 1, holes, tail: holes ? tail : value };
    if (q !== '`' && c === '\n') return null;
    if (q === '`' && c === '$' && src[j + 1] === '{') {
      let depth = 1;
      j += 2;
      for (; j < src.length && depth; j++) {
        const d = src[j]!;
        if (d === '{') depth++;
        else if (d === '}') depth--;
        else if (QUOTES.has(d)) { const s = readString(src, j); if (s) j = s.end - 1; }
      }
      j--;
      value += '{}';
      holes++;
      tail = '';
      continue;
    }
    value += c;
    tail += c;
  }
  return null;
}

/** Index just past the `)` that closes the call whose `(` is at `open - 1`, skipping strings; src.length if unbalanced. */
function argsEnd(src: string, open: number): number {
  let depth = 1;
  for (let j = open; j < src.length; j++) {
    const c = src[j]!;
    if (QUOTES.has(c)) { const s = readString(src, j); if (s) { j = s.end - 1; continue; } }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (!depth) return j + 1; }
  }
  return src.length;
}

const skipWs = (src: string, i: number) => { while (i < src.length && /\s/.test(src[i]!)) i++; return i; };

/** Path part of a URL: origin, query and hash dropped, slashes collapsed. Null unless it is a path (starts with `/`). */
export function urlPath(raw: string): string | null {
  let u = raw.trim().replace(/^https?:\/\/[^/]+/, '');
  u = u.replace(/[?#].*$/, '').replace(/\/{2,}/g, '/');
  if (!u.startsWith('/')) return null;
  return u.length > 1 ? u.replace(/\/$/, '') : u;
}

function enclosing(file: SourceFile, at: number): string {
  let best: SymbolFact | null = null;
  for (const s of file.symbols) {
    if (s.kind === 'type' || s.span.end <= s.span.start || at < s.span.start || at >= s.span.end) continue;
    if (!best || s.span.end - s.span.start < best.span.end - best.span.start) best = s;
  }
  return best?.id ?? file.path;
}

const shortName = (id: string) => (id.includes('#') ? id.slice(id.indexOf('#') + 1).split('.').at(-1)! : null);

/** Without symbol spans: the name of the nearest function-like definition before `at` (`function f(`, `f = (…) =>`, `f(…) {`). */
function definedBefore(src: string, at: number): string | null {
  const head = src.slice(Math.max(0, at - 2000), at);
  let name: string | null = null;
  for (const m of head.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?(?:function\b|\([^()]*\)\s*(?::[^=]*?)?=>|[A-Za-z_$][\w$]*\s*=>)/g)) name = m[1] ?? m[2] ?? name;
  return name;
}

type Wrapper = { name: string; prefix: string; method: string | null; symbol: string };

/**
 * Every fetch site in `files`:
 * 1. direct calls (`fetch`, `$fetch`, `ofetch`, `axios.<m>`, `ky.<m>`) whose first argument is a URL literal;
 * 2. wrappers: a function whose `fetch` takes a non-literal URL (`fetch(path)`, ``fetch(`/api${path}`)``) is a wrapper
 *    with that prefix; calls to it by name, anywhere, with a URL literal first argument are sites (`via` = its name).
 * The method comes from the client name (`axios.post`) or a `method: "POST"` in the call's arguments; else GET.
 * Sorted by file, then position.
 */
export function findFetchSites(files: readonly SourceFile[]): FetchSite[] {
  const wrappers = new Map<string, Wrapper>();
  const sites: (FetchSite & { at: number })[] = [];
  const methodIn = (src: string, from: number, to: number) => /\bmethod\s*:\s*["'`]([A-Za-z]+)["'`]/.exec(src.slice(from, to))?.[1]?.toUpperCase() ?? null;

  for (const f of files) {
    const src = f.source;
    if (!/fetch|axios|ky\s*\./.test(src)) continue;
    for (const m of src.matchAll(CLIENT)) {
      const open = m.index + m[0].length;
      const end = argsEnd(src, open);
      const a = skipWs(src, open);
      const str = readString(src, a);
      const client = m[1] ?? `${m[2]}.${m[3]}`;
      const fixed = m[3] ? m[3].toUpperCase() : null;
      const from = enclosing(f, m.index);
      if (str) {
        // `${…}` right after a literal prefix that doesn't end in `/` (e.g. `/api${path}`): a wrapper, not a site.
        const lead = str.value.indexOf('{}');
        if (str.holes && lead >= 0 && !str.value.slice(0, lead).endsWith('/') && str.tail === '' && str.holes === 1) {
          const name = shortName(from) ?? definedBefore(src, m.index);
          if (name) wrappers.set(name, { name, prefix: str.value.slice(0, lead), method: fixed ?? methodIn(src, str.end, end), symbol: from });
          continue;
        }
        const url = urlPath(str.value);
        if (url) sites.push({ file: f.path, from, method: fixed ?? methodIn(src, str.end, end) ?? 'GET', url, exact: str.holes === 0, via: client === 'fetch' ? null : client, at: m.index });
      } else if (/^[A-Za-z_$][\w$]*\s*[,)]/.test(src.slice(a, a + 80))) {
        const name = shortName(from) ?? definedBefore(src, m.index);
        if (name) wrappers.set(name, { name, prefix: '', method: fixed ?? methodIn(src, a, end), symbol: from });
      }
    }
  }

  if (wrappers.size) {
    const names = [...wrappers.keys()].map((n) => n.replace(/[$]/g, '\\$')).join('|');
    const call = new RegExp(`(?<![\\w$])(${names})\\s*(?:<[^()]*?>)?\\s*\\(`, 'g');
    for (const f of files) {
      const src = f.source;
      for (const m of src.matchAll(call)) {
        if (/\bfunction\s*\*?\s*$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue; // the definition
        const w = wrappers.get(m[1]!)!;
        const open = m.index + m[0].length;
        const a = skipWs(src, open);
        const str = readString(src, a);
        if (!str) continue;
        const url = urlPath(w.prefix + str.value);
        if (!url) continue;
        const from = enclosing(f, m.index);
        if (from === w.symbol && from.includes('#')) continue; // a wrapper calling itself
        sites.push({ file: f.path, from, method: w.method ?? methodIn(src, str.end, argsEnd(src, open)) ?? 'GET', url, exact: str.holes === 0 && w.prefix === '', via: w.name, at: m.index });
      }
    }
  }
  return sites
    .sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : x.at - y.at))
    .map(({ at: _at, ...s }) => s);
}

const segs = (p: string) => p.split('/').filter(Boolean);
const segRe = (s: string) => new RegExp(`^${s.split('{}').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+')}$`);

/**
 * The route a site calls: same number of path segments, each equal or matched through a `{}` on either side, and the
 * same method (a route with method ANY matches any). Among matches the one with the fewest wildcards wins (then id).
 * `syntactic` when the site's URL is exact and matched a route segment-for-segment with no wildcard on the site side;
 * otherwise `inferred`.
 */
export function matchRoute(site: Pick<FetchSite, 'method' | 'url' | 'exact'>, routes: readonly RouteFact[]): { route: RouteFact; confidence: 'syntactic' | 'inferred' } | null {
  const want = segs(site.url);
  let best: { route: RouteFact; wild: number; siteWild: boolean } | null = null;
  for (const r of routes) {
    if (r.method !== site.method && r.method !== 'ANY') continue;
    const have = segs(r.path);
    if (have.length !== want.length) continue;
    let wild = 0;
    let siteWild = false;
    let ok = true;
    for (let i = 0; i < have.length && ok; i++) {
      const [h, w] = [have[i]!, want[i]!];
      if (h === w) continue;
      if (h === '{}') { wild++; continue; }
      if (w.includes('{}') && segRe(w).test(h)) { wild++; siteWild = true; continue; }
      if (h.includes('{}') && segRe(h).test(w)) { wild++; continue; }
      ok = false;
    }
    if (!ok) continue;
    if (!best || wild < best.wild || (wild === best.wild && r.id < best.route.id)) best = { route: r, wild, siteWild };
  }
  if (!best) return null;
  const exact = site.exact && !best.siteWild && best.route.method !== 'ANY';
  return { route: best.route, confidence: exact ? 'syntactic' : 'inferred' };
}
