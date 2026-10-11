// Route paths and file-based routes (Next.js). Pure and browser-safe.
import type { RouteFact } from '../contracts/facts';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/**
 * Normalize a route path so ids are stable: params (`:id`, `{id}`, `[id]`, `[...x]`, regex groups `([\w-]+)`) become `{}`,
 * regex anchors and escapes are dropped, and a leading `/` is ensured.
 */
export function normalizeRoutePath(raw: string): string {
  let p = raw.trim().replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/');
  p = p.replace(/\((?:[^()\\]|\\.)*\)\??/g, '{}'); // regex capture groups
  p = p.replace(/\[\[?\.{0,3}[^\]/]*\]?\]/g, '{}'); // [id], [...slug], [[...slug]]
  p = p.replace(/:[A-Za-z_$][\w$]*\??/g, '{}').replace(/\{[^}/]+\}/g, '{}').replace(/\{\}[+*?]+/g, '{}');
  p = p.replace(/(^|\/)\*+(?=\/|$)/g, '$1{}');
  p = p.replace(/\\(.)/g, '$1').replace(/\/+/g, '/');
  if (!p.startsWith('/')) p = `/${p}`;
  return p.length > 1 ? p.replace(/\/$/, '') : p;
}

export const routeId = (method: string, path: string) => `route:${method} ${path}`;

export function routeFact(method: string, rawPath: string, file: string, handler: string | null): RouteFact {
  const m = method.toUpperCase() === 'ALL' ? 'ANY' : method.toUpperCase();
  const path = normalizeRoutePath(rawPath);
  return { id: routeId(m, path), method: m, path, file, handler };
}

const NEXT_APP_ROUTE = /(?:^|\/)app\/((?:.*\/)?)route\.[cm]?[jt]sx?$/;
const NEXT_APP_PAGE = /(?:^|\/)app\/((?:.*\/)?)page\.[cm]?[jt]sx?$/;
const NEXT_PAGES = /(?:^|\/)pages\/(.*)\.[cm]?[jt]sx?$/;

/** URL path for a Next.js segment list: route groups `(x)` and slots `@x` drop out. */
const segmentsToPath = (dir: string) =>
  normalizeRoutePath(`/${dir.split('/').filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@')).join('/')}`);

/** Next.js file-based routes and pages for `path`, given its export names. Handlers are symbol names in the file. */
export function nextRoutes(path: string, exportNames: readonly string[]): { routes: { method: string; path: string; symbol: string }[]; page: string | null } {
  let m = NEXT_APP_ROUTE.exec(path);
  if (m) {
    const url = segmentsToPath(m[1]!);
    return { routes: exportNames.filter((n) => HTTP_METHODS.includes(n)).map((n) => ({ method: n, path: url, symbol: n })), page: null };
  }
  m = NEXT_APP_PAGE.exec(path);
  if (m) return { routes: [], page: segmentsToPath(m[1]!) };
  m = NEXT_PAGES.exec(path);
  if (m) {
    const rest = m[1]!.replace(/(?:^|\/)index$/, '');
    if (/^api(?:\/|$)/.test(rest)) return { routes: exportNames.includes('default') ? [{ method: 'ANY', path: segmentsToPath(rest), symbol: 'default' }] : [], page: null };
    if (/(?:^|\/)_(?:app|document|error)$/.test(rest) || /^_/.test(rest)) return { routes: [], page: null };
    return { routes: [], page: segmentsToPath(rest) };
  }
  return { routes: [], page: null };
}
