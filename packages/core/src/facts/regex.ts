// Regex fallback for source that doesn't parse (mid-edit files). Browser-safe.

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

const STATIC_FROM = /(?<![\w$.])(?:import|export)\s+(type\s+)?[\w$\s{},*]*?\bfrom\s*(['"])([^'"\n]+)\2/g;
const SIDE_EFFECT = /(?<![\w$.])import\s*(['"])([^'"\n]+)\1/g;
const DYNAMIC = /(?<![\w$.])import\s*\(\s*(['"`])([^'"`$\n]+)\1\s*\)/g;
export const REQUIRE = /(?<![\w$.])require\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;

export type SpecSite = { spec: string; typeOnly: boolean; at: number };

/** Import specifiers in comment-stripped code, in source order (regex; the fallback when parsing fails). */
export function regexImports(code: string): SpecSite[] {
  const found: SpecSite[] = [];
  for (const m of code.matchAll(STATIC_FROM)) found.push({ spec: m[3]!, typeOnly: !!m[1], at: m.index });
  for (const re of [SIDE_EFFECT, DYNAMIC, REQUIRE]) {
    for (const m of code.matchAll(re)) found.push({ spec: m[2]!, typeOnly: false, at: m.index });
  }
  return found.sort((a, b) => a.at - b.at);
}
