import { describe, expect, it } from 'vitest';
import { bashWriteTarget } from '../../../apps/server/src/session';

const rel = (p: string) => (p.startsWith('/tmp') || p.startsWith('/dev') ? null : p.replace(/^['"]|['"]$/g, ''));

describe('bash write gate', () => {
  it('blocks writes into the repo through the shell', () => {
    expect(bashWriteTarget("cat > src/tools/x.ts <<'EOF'\nhi\nEOF", rel)).toBe('redirect to src/tools/x.ts');
    expect(bashWriteTarget("sed -i '' 's/a/b/' src/a.ts", rel)).toBe('in-place edit');
    expect(bashWriteTarget('echo hi | tee -a notes.txt', rel)).toBe('tee notes.txt');
    expect(bashWriteTarget("python3 - <<'EOF'\nopen('src/a.ts','w').write('x')\nEOF", rel)).toBe('script that writes files');
  });

  it('lets tests, reads and arrow functions through', () => {
    expect(bashWriteTarget('npx vitest run 2>&1 | tail -5; npx tsc --noEmit && echo OK', rel)).toBeNull();
    expect(bashWriteTarget('npm test > /dev/null 2>&1', rel)).toBeNull();
    expect(bashWriteTarget(`npx tsx -e "import('./src/orchestrator/planner').then((m) => console.log(m.pick('x')))"`, rel)).toBeNull();
    expect(bashWriteTarget("node -e \"[1,2].map(x => x * 2)\"", rel)).toBeNull();
    expect(bashWriteTarget("echo 'a -> b'", rel)).toBeNull();
  });
});
