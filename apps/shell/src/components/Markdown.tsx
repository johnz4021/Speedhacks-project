import { Fragment, type ReactNode } from 'react';

/** Just enough markdown for chat: fenced code, headings, lists, paragraphs, `code`, **bold**, *italic*. */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = line.match(/^\s*```(\w*)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      blocks.push(<pre key={key++} className="md-pre"><code>{body.join('\n')}</code></pre>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const heading = line.match(/^(#{1,4})\s+(.*)/);
    if (heading) {
      blocks.push(<p key={key++} className="md-h">{inline(heading[2]!)}</p>);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i]!)) {
        let item = lines[i]!.replace(/^\s*([-*]|\d+[.)])\s+/, '');
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i]!)) item += ' ' + lines[i++]!.trim();
        items.push(item);
      }
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(<Tag key={key++} className="md-list">{items.map((it, j) => <li key={j}>{inline(it)}</li>)}</Tag>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^\s*(```|#{1,4}\s|[-*]\s|\d+[.)]\s)/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(<p key={key++}>{inline(para.join(' '))}</p>);
  }
  return <div className="md">{blocks}</div>;
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(<Fragment key={k++}>{s.slice(last, m.index)}</Fragment>);
    const t = m[0];
    if (m[1]) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(<Fragment key={k++}>{s.slice(last)}</Fragment>);
  return out;
}
