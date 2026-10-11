// SPEC §13 step 0: verify the Agent SDK behaviours the harness depends on.
// Usage: npm run verify -w @harness/server -- [a|d]   (default: both)
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  query,
  tool,
  createSdkMcpServer,
  type SDKUserMessage,
  type HookCallback,
  type PreToolUseHookInput,
  type CanUseTool,
  type SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);

function makeRepo(): string {
  const dir = join(tmpdir(), 'harness-verify-repo');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'src/tools'), { recursive: true });
  mkdirSync(join(dir, 'src/gateway'), { recursive: true });
  mkdirSync(join(dir, 'vendor/llm-openai'), { recursive: true });
  writeFileSync(join(dir, 'vendor/llm-openai/index.ts'), `export async function chat(prompt: string) { return 'ok: ' + prompt; }\n`);
  writeFileSync(join(dir, 'src/gateway/complete.ts'), `import { chat } from '../../vendor/llm-openai/index';\nexport async function complete(text: string) { return chat(text); }\n`);
  writeFileSync(join(dir, 'src/tools/news.ts'), `import { chat } from '../../vendor/llm-openai/index';\nexport async function summarizeNews(text: string) { return chat('Summarize: ' + text); }\n`);
  execSync('git init -q && git add -A && git -c user.email=v@v -c user.name=v commit -qm init', { cwd: dir });
  return dir;
}

/** Push-based async iterable so we can feed chat messages over time. */
function inbox() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(text: string) {
      queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
      wake?.();
    },
    close() { closed = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
    },
  };
}

async function verifyABC(settingSources: SettingSource[]) {
  const repo = makeRepo();
  const results = { a_submitPlanCalled: false, a_permissionModeAtCall: '', b_exitPlanModeSeen: false, c_denied: 0, c_toolsAfterDeny: [] as string[], c_finalText: '' };
  let denyAt = -1;
  const toolCalls: string[] = [];

  const harness = createSdkMcpServer({
    name: 'interpretability',
    version: '0.0.1',
    tools: [
      tool(
        'submit_plan',
        'Submit the numbered plan before editing. Each step lists files it creates/modifies and new imports.',
        { steps: z.array(z.object({ n: z.number(), text: z.string(), files: z.array(z.string()), imports: z.array(z.object({ from: z.string(), to: z.string() })) })) },
        async (args) => {
          results.a_submitPlanCalled = true;
          log('submit_plan', JSON.stringify(args));
          return { content: [{ type: 'text', text: 'Plan recorded. No violations. You may now exit plan mode.' }] };
        },
        { alwaysLoad: true },
      ),
    ],
  });

  const observe: HookCallback = async (input) => {
    const i = input as PreToolUseHookInput;
    toolCalls.push(i.tool_name);
    if (i.tool_name === 'mcp__interpretability__submit_plan') results.a_permissionModeAtCall = i.permission_mode ?? '';
    if (denyAt >= 0 && toolCalls.length - 1 > denyAt) results.c_toolsAfterDeny.push(i.tool_name);
    return { async: true };
  };

  const gate: HookCallback = async (input) => {
    const i = input as PreToolUseHookInput;
    const ti = i.tool_input as { file_path?: string; content?: string; new_string?: string };
    const text = ti.content ?? ti.new_string ?? '';
    if (!ti.file_path?.startsWith(repo) && !ti.file_path?.startsWith('/private' + repo)) return {};
    if (!/vendor\/llm-/.test(text)) return {};
    results.c_denied++;
    denyAt = toolCalls.length - 1;
    log('gate DENY', ti.file_path);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `${ti.file_path} imports vendor/llm-openai directly, but DR-1: Model providers are only called through the model gateway. ` +
          `Stop and ask the user to choose, in one short message: (A) route it through src/gateway/complete.ts, or (B) add an exception for this file and record why. ` +
          `Do not try another route; wait for the answer.`,
      },
    };
  };

  const canUseTool: CanUseTool = async (name, input) => {
    log('canUseTool', name);
    if (name === 'ExitPlanMode') {
      results.b_exitPlanModeSeen = true;
      setTimeout(() => q.setPermissionMode('acceptEdits').catch((e) => log('setPermissionMode failed', e)), 0);
      return { behavior: 'allow', updatedInput: input };
    }
    if (name.startsWith('mcp__interpretability__')) return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: `${name} is not available in this session.` };
  };

  const chat = inbox();
  chat.push(
    'Add a tool in src/tools/filing.ts that summarizes a 10-K. Copy the approach of src/tools/news.ts exactly ' +
      '(import the vendor client directly, the same way news.ts does). Keep it under 10 lines.',
  );

  const q = query({
    prompt: chat,
    options: {
      cwd: repo,
      permissionMode: 'plan',
      settingSources,
      planModeInstructions:
        'Explore briefly (at most 3 reads). Then call mcp__interpretability__submit_plan with numbered steps, each listing exact file paths and new imports (from path → to path). Then call ExitPlanMode.',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Never work around a denied edit. If an edit is denied with options, ask the user and wait.' },
      mcpServers: { interpretability: harness },
      allowedTools: ['mcp__interpretability__submit_plan'],
      disallowedTools: ['AskUserQuestion'],
      hooks: {
        PreToolUse: [
          { hooks: [observe] },
          { matcher: 'Edit|Write|MultiEdit', hooks: [gate] },
        ],
      },
      canUseTool,
      maxTurns: 30,
    },
  });

  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') log('init model', m.model, 'apiKeySource', m.apiKeySource, 'mcp', JSON.stringify(m.mcp_servers));
    if (m.type === 'assistant') {
      for (const b of m.message.content) {
        if (b.type === 'text') { log('assistant:', b.text.slice(0, 400)); results.c_finalText = b.text; }
        if (b.type === 'tool_use') log('tool_use:', b.name, JSON.stringify(b.input).slice(0, 160));
      }
    }
    if (m.type === 'result') { log('result', m.subtype, 'cost $' + m.total_cost_usd?.toFixed(4)); chat.close(); }
  }
  log('ABC', JSON.stringify(results, null, 2));
  log('wrote filing.ts?', existsSync(join(repo, 'src/tools/filing.ts')));
  return results;
}

async function verifyD(settingSources: SettingSource[] | undefined) {
  const q = query({
    prompt: 'Reply with the single word OK.',
    options: { cwd: tmpdir(), maxTurns: 1, ...(settingSources ? { settingSources } : {}), includeHookEvents: true },
  });
  const hooks = new Set<string>();
  let mcp = '';
  let alikeTools = 0;
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') {
      mcp = JSON.stringify(m.mcp_servers);
      alikeTools = m.tools.filter((t) => t.startsWith('mcp__alike__')).length;
    }
    if (m.type === 'system' && (m.subtype as string) === 'hook_started') hooks.add(String((m as { hook_name?: string }).hook_name));
  }
  const out = { settingSources: settingSources ?? 'default(all)', mcp, alikeTools, hooksSeen: [...hooks] };
  log('D', JSON.stringify(out));
  return out;
}

const which = process.argv[2] ?? 'all';
if (which === 'a' || which === 'all') await verifyABC(['project', 'local']);
if (which === 'd' || which === 'all') {
  await verifyD(undefined);
  await verifyD(['project', 'local']);
}

/** (d) part 2: Alike passed explicitly, user settings (and so Alike's hooks) off. Can Claude call it? */
async function verifyD2(explicit: boolean) {
  const q = query({
    prompt: 'Call mcp__alike__describe_entity_kind with the kind "decision" and reply with the list of field names it returns, nothing else. If the tool is unavailable or fails, reply with the exact error.',
    options: {
      cwd: tmpdir(),
      maxTurns: 4,
      settingSources: explicit ? ['project', 'local'] : undefined,
      ...(explicit ? { mcpServers: { alike: { type: 'http' as const, url: 'https://alike.network/api-general/mcp' } } } : {}),
      allowedTools: ['mcp__alike__describe_entity_kind'],
      includeHookEvents: true,
      ...(process.env.CLAUDE_BIN ? { pathToClaudeCodeExecutable: process.env.CLAUDE_BIN } : {}),
    },
  });
  const hooks = new Set<string>();
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') log('D2 init alike:', JSON.stringify(m.mcp_servers.filter((s) => s.name.includes('alike'))));
    if (m.type === 'system' && (m.subtype as string) === 'hook_started') hooks.add(String((m as { hook_name?: string }).hook_name));
    if (m.type === 'assistant') for (const b of m.message.content) {
      if (b.type === 'tool_use') log('D2 tool_use', b.name);
      if (b.type === 'text') log('D2 text:', b.text.slice(0, 600));
    }
    if (m.type === 'user' && Array.isArray(m.message.content)) for (const b of m.message.content) {
      if (typeof b === 'object' && b.type === 'tool_result') log('D2 tool_result:', JSON.stringify(b.content).slice(0, 600));
    }
  }
  log('D2 explicit=' + explicit, 'hooks', [...hooks]);
}
if (which === 'd2') { await verifyD2(true); await verifyD2(false); }
