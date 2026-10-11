const REGEX_PRECEDERS = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new)$/;

/**
 * Replace `//` and `/* *\/` comments with spaces (newlines kept), leaving strings,
 * template literals and regex literals intact, so offsets and line numbers still match.
 */
export function stripComments(src: string): string {
  const n = src.length;
  let out = '';
  let i = 0;

  const copyQuoted = (quote: string) => {
    out += src[i++];
    while (i < n && src[i] !== quote && src[i] !== '\n') {
      if (src[i] === '\\') out += src[i++];
      if (i < n) out += src[i++];
    }
    if (i < n && src[i] === quote) out += src[i++];
  };

  const copyRegex = () => {
    let inClass = false;
    out += src[i++];
    while (i < n && src[i] !== '\n') {
      const c = src[i]!;
      if (c === '\\') {
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      out += c;
      i++;
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
    }
  };

  const copyTemplate = () => {
    out += src[i++];
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') {
        out += src.slice(i, i + 2);
        i += 2;
      } else if (src[i] === '$' && src[i + 1] === '{') {
        out += '${';
        i += 2;
        code(true);
      } else out += src[i++];
    }
    if (i < n) out += src[i++];
  };

  // Scan code; when `inTemplate`, stop after the `}` that closes the `${`.
  function code(inTemplate: boolean) {
    let depth = 0;
    while (i < n) {
      const c = src[i]!;
      const next = src[i + 1];
      if (c === '/' && next === '/') {
        while (i < n && src[i] !== '\n') {
          out += ' ';
          i++;
        }
      } else if (c === '/' && next === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end === -1 ? n : end + 2;
        out += src.slice(i, stop).replace(/[^\n]/g, ' ');
        i = stop;
      } else if (c === '"' || c === "'") copyQuoted(c);
      else if (c === '`') copyTemplate();
      else if (c === '/') {
        const before = out.trimEnd();
        const prev = before[before.length - 1];
        if (prev === undefined || REGEX_PRECEDERS.has(prev) || REGEX_KEYWORDS.test(before)) copyRegex();
        else out += src[i++];
      } else {
        if (c === '{') depth++;
        else if (c === '}') {
          if (inTemplate && depth === 0) {
            out += src[i++];
            return;
          }
          depth--;
        }
        out += src[i++];
      }
    }
  }

  code(false);
  return out;
}

const STATIC_FROM = /(?<![\w$.])(?:import|export)\s+(?:type\s+)?[\w$\s{},*]*?\bfrom\s*(['"])([^'"\n]+)\1/g;
const SIDE_EFFECT = /(?<![\w$.])import\s*(['"])([^'"\n]+)\1/g;
const DYNAMIC = /(?<![\w$.])import\s*\(\s*(['"`])([^'"`$\n]+)\1\s*\)/g;

/** Module specifiers imported or re-exported by `source`, in source order. Comments are ignored. */
export function parseImports(source: string): string[] {
  const code = stripComments(source);
  const found: { at: number; spec: string }[] = [];
  for (const re of [STATIC_FROM, SIDE_EFFECT, DYNAMIC]) {
    for (const m of code.matchAll(re)) found.push({ at: m.index, spec: m[2]! });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.spec);
}

/** Normalize a repo-relative path: POSIX separators, no `./`, `.`/`..` resolved. Null if it escapes the root. */
export function normalizePath(path: string): string | null {
  const parts: string[] = [];
  for (const seg of path.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Directory part of a repo-relative path ('' for root files). */
export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

const EXT_SWAPS: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'] };

/** First existing file for a repo path written the way an import would be: as is, swapped JS extension, `.ts`, `.tsx`, `/index.ts`, `/index.tsx`. */
export function resolvePath(path: string, exists: (path: string) => boolean): string | null {
  const base = normalizePath(path);
  if (!base) return null;
  const candidates = [base];
  const ext = base.match(/\.(?:js|jsx|mjs)$/)?.[0];
  if (ext) for (const swap of EXT_SWAPS[ext]!) candidates.push(base.slice(0, -ext.length) + swap);
  candidates.push(`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`);
  return candidates.find((c) => exists(c)) ?? null;
}

/** Resolve a relative specifier imported by `fromFile` to an existing repo file. Bare and `node:` specifiers give null. */
export function resolveImport(fromFile: string, specifier: string, exists: (path: string) => boolean): string | null {
  if (!isRelative(specifier)) return null;
  const dir = dirname(normalizePath(fromFile) ?? '');
  return resolvePath(dir ? `${dir}/${specifier}` : specifier, exists);
}

export function isRelative(specifier: string): boolean {
  return specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
}
