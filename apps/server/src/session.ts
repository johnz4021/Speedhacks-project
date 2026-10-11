import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  query, type Query, type SDKUserMessage, type HookCallback, type PreToolUseHookInput, type PostToolUseHookInput,
  type CanUseTool, type PermissionResult, type McpServerConfig,
} from '@anthropic-ai/claude-agent-sdk';
import { applyEdit, deltaForEdit, check, withExtra, protectsSummary, type PlanStep, type Violation, type EventData } from '@harness/core';
import { harnessTools, violationText, decidedText, splitDecided, editTouchesFor, ASK_RULE } from './harness-tools';
import { listDecisions, parseOption, recordFork, recordInAlike, recordProtects } from './decisions';
import { baseline, numstat, type Baseline } from './git';
import type { Repo } from './repo';
import type { Bus } from './bus';

/** Beat 1: questions about the system are answered from the graph the user sees, not by reading file after file. */
export const GRAPH_FIRST =
  'For questions about the system (architecture, who calls what, where data goes), answer from the mcp__interpretability__ graph tools first — overview, trace, graph_neighbors, symbols_in, domain, who_writes — and cite repo paths so the user can click them; read files only to confirm details. Keep the answer short: the user sees it drawn on the map.';

const PLAN_RULES = [
  'If the user only asks a question, answer it (see below); a question needs no plan and no ExitPlanMode.',
  GRAPH_FIRST,
  'To change code: explore read-only, briefly. Then, before editing anything, call mcp__interpretability__submit_plan with numbered steps.',
  'Each step lists the exact repo-relative file paths it will create or modify, every new import it adds as { from: path, to: path }, and the functions it adds or changes as `symbols` ("path#name").',
  'If the result contains violations: ' + ASK_RULE,
  'If a violation is ALREADY DECIDED in a standing decision (DR-n), do not ask: plan it the decided way and resubmit.',
  'If a standing decision rules out the obvious approach, plan the decided way and list the avoided approach in `avoided` with the decision id.',
  'If the result says the plan touches what a decision protects, keep that decision true: scope the steps so it still holds (resubmit if needed) and extend its test. Never ask the user about it.',
  'After the user answers, resubmit the plan with mcp__interpretability__submit_plan, then call ExitPlanMode.',
  'If there are no violations, call ExitPlanMode with a short plan.',
].join('\n');

/** The coding session's model and effort: the same model as plain Claude Code in beat 1 (user settings are skipped). */
export function sessionModel(env: NodeJS.ProcessEnv = process.env): { model: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' } {
  const effort = env.HARNESS_EFFORT;
  const ok = effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max';
  return { model: env.HARNESS_MODEL || 'claude-opus-5-5', ...(ok ? { effort } : {}) };
}

/** Push-based prompt stream fed by the chat pane. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  push(text: string) {
    this.queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.queue.length) yield this.queue.shift()!;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}

type Turn = {
  id: string;
  prompt: string;
  base: Baseline;
  planned: boolean;
  steps: PlanStep[];
  planViolations: Violation[]; // from the latest submit_plan
  gateBlocks: Violation[]; // since the last answer
  forkOpen: Violation[] | null; // asked, awaiting the user's A/B
  lastText: string;
  reminded: Set<string>; // decisions whose protected code an edit touched: reminded once per turn
};

/** If a shell command writes a file inside the repo, a short description of how; otherwise null. */
export function bashWriteTarget(cmd: string, rel: (p: string) => string | null): string | null {
  const inRepo = (p: string) => !!p && !p.startsWith('/dev/') && rel(p.replace(/^['"]|['"]$/g, '')) !== null;
  // Redirects to a file: `> f`, `>> f`, `cat <<EOF > f` (not 2>&1, >&2, >/dev/null).
  // `=>` and `->` (arrow functions, prose) are not redirects.
  for (const m of cmd.matchAll(/(?:^|[^0-9&>=-])>>?\s*([^\s;&|<>()]+)/g)) if (!m[1]!.startsWith('&') && inRepo(m[1]!)) return `redirect to ${m[1]}`;
  for (const m of cmd.matchAll(/\btee\s+(?:-a\s+)?([^\s;&|<>()]+)/g)) if (inRepo(m[1]!)) return `tee ${m[1]}`;
  if (/\b(sed|perl)\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*i/.test(cmd)) return 'in-place edit';
  if (/\b(python3?|node|ruby|perl|deno|bun)\b[\s\S]*(open\([^)]*['"][wa]\+?['"]|write_text|writeFileSync|appendFileSync|\.write\(|fs\.write)/.test(cmd)) return 'script that writes files';
  return null;
}

export type Ephemeral = (msg: { type: 'delta'; text: string } | { type: 'busy'; busy: boolean }) => void;

export class Session {
  private inbox = new Inbox();
  private q: Query | null = null;
  private turn: Turn | null = null;
  private approval: { resolve: (r: PermissionResult) => void; input: Record<string, unknown> } | null = null;
  private notes: string[] = [];
  busy = false;

  constructor(private repo: Repo, private bus: Bus, private ephemeral: Ephemeral) {}

  brief(): string {
    const m = this.repo.map;
    const domains = m.domains.map((d) => {
      const cells = Object.entries(d.cells).map(([layer, c]) => `    ${layer}: ${[...(c.paths ?? []), ...(c.tables ?? []).map((t) => `table ${t}`)].join(', ')}`);
      return `- ${d.name} (${d.id}): ${d.purpose}\n${cells.join('\n')}`;
    });
    // Rejected map proposals are cartographer memory, not standing decisions for the coding agent.
    const decisions = listDecisions(this.repo.root).filter((d) => d.status !== 'rejected').map((d) =>
      `- ${d.id}: ${d.title}\n  Outcome: ${d.outcome}\n  Rejected: ${d.rejected}${d.protects ? `\n  Protects: ${protectsSummary(d.protects)} (keep it true when changing this code)` : ''}\n  ${d.rationale.replace(/\n+/g, '\n  ')}`);
    // Seeded invariants are deliberately not listed (SPEC §6): they are enforced at plan and edit time.
    return [
      '# Interpretability',
      'You are working inside Interpretability, which shows the user a live domain × layer map of this repo and checks every plan and edit against its architecture rules.',
      '',
      '## Map (domains.yaml)',
      `Layers: ${m.layers.map((l) => l.id).join(', ')}`,
      ...domains,
      '',
      '## Standing decisions the user has made',
      decisions.length ? decisions.join('\n') : '(none yet)',
      '',
      '## Rules',
      PLAN_RULES,
      'The graph tools (overview, trace, graph_neighbors, symbols_in, domain, who_writes, cell_for) are always loaded; call them directly.',
      'Change files only with the Edit and Write tools, never through Bash (no heredocs, `sed -i` or scripts that write files): Interpretability checks each Edit/Write against the rules.',
      'If an edit is denied with options A and B: ' + ASK_RULE,
    ].join('\n');
  }

  start() {
    const alike: Record<string, McpServerConfig> = process.env.HARNESS_ALIKE === '0' ? {} : { alike: { type: 'http', url: 'https://alike.network/api-general/mcp' } };
    this.q = query({
      prompt: this.inbox,
      options: {
        cwd: this.repo.root,
        ...sessionModel(),
        permissionMode: 'plan',
        planModeInstructions: PLAN_RULES,
        // User settings carry Alike's own hooks (network calls); keep the hot path deterministic. See VERIFY.md.
        settingSources: ['project', 'local'],
        strictMcpConfig: true,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: this.brief() },
        mcpServers: {
          interpretability: harnessTools(this.repo, this.bus, {
            onPlan: (steps, violations) => this.onPlan(steps, violations),
            takeNotes: () => this.notes.splice(0),
          }),
          ...alike,
        },
        // No allowedTools: canUseTool approves everything except ExitPlanMode, which waits for the user.
        disallowedTools: ['AskUserQuestion'],
        includePartialMessages: true,
        hooks: {
          PreToolUse: [
            { matcher: 'Read|Grep|Glob', hooks: [this.observeRead] },
            { matcher: 'Bash', hooks: [this.observeBash, this.gateBash] },
            { matcher: 'Edit|Write', hooks: [this.gate] },
          ],
          PostToolUse: [
            { matcher: 'Edit|Write', hooks: [this.afterEdit] },
            { matcher: 'mcp__alike__record_decision', hooks: [this.afterAlike] },
          ],
        },
        canUseTool: this.canUseTool,
        stderr: (d) => { if (process.env.HARNESS_DEBUG) process.stderr.write(d); },
      },
    });
    void this.loop();
  }

  private async loop() {
    try {
      for await (const m of this.q!) {
        if (m.type === 'stream_event') {
          const ev = m.event as { type: string; delta?: { type: string; text?: string } };
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) this.ephemeral({ type: 'delta', text: ev.delta.text });
        } else if (m.type === 'assistant' && !m.parent_tool_use_id) {
          const t = m.message.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
          if (t) {
            this.bus.emit('chat', { role: 'assistant', text: t });
            if (this.turn) this.turn.lastText = t;
          }
        } else if (m.type === 'result') {
          this.onResult(m.subtype);
        }
      }
    } catch (e) {
      this.bus.emit('error', { message: `Session ended: ${(e as Error).message}` });
    }
  }

  // ---------------------------------------------------------------- chat input

  userMessage(text: string) {
    const t = text.trim();
    if (!t) return;
    if (this.approval) {
      this.bus.emit('chat', { role: 'user', text: t });
      if (/^(approve|approved|lgtm|yes|ok|go|ship it)\b/i.test(t)) this.approve();
      else this.rejectPlan(t);
      return;
    }
    if (this.turn?.forkOpen) {
      const violations = this.turn.forkOpen;
      const option = parseOption(t);
      this.bus.emit('chat', { role: 'user', text: t });
      this.bus.emit('fork_answered', { option, text: t, violations });
      this.turn.forkOpen = null;
      this.turn.planViolations = [];
      this.turn.gateBlocks = [];
      const { decisions, forAlike } = recordFork(this.repo, this.bus, violations, option, t, this.turn.prompt);
      // The server records in Alike itself, off the turn; only if the CLI fails does the session get an MCP note.
      if (process.env.HARNESS_ALIKE !== '0') void recordInAlike(this.repo, this.bus, forAlike).then((notes) => this.notes.push(...notes));
      const ids = decisions.map((d) => d.id).join(', ');
      this.send(`${t}\n\n[Interpretability: recorded as ${ids || 'a decision'} in decisions/ and domains.yaml. ` +
        (option === 'B' ? `${violations[0]?.file} is now an exception. ` : '') +
        'Resubmit the plan with mcp__interpretability__submit_plan, then exit plan mode.]');
      return;
    }
    if (!this.turn) this.startTurn(t);
    this.bus.emit('chat', { role: 'user', text: t });
    this.send(t);
  }

  private send(text: string) {
    this.busy = true;
    this.ephemeral({ type: 'busy', busy: true });
    this.inbox.push(text);
  }

  private startTurn(prompt: string) {
    const id = `t${randomUUID().slice(0, 6)}`;
    this.turn = { id, prompt, base: baseline(this.repo.root), planned: false, steps: [], planViolations: [], gateBlocks: [], forkOpen: null, lastText: '', reminded: new Set() };
    this.bus.turn = id;
    this.bus.emit('turn_started', { prompt, head: this.turn.base.head, baseline: this.turn.base.snapshot });
  }

  approve() {
    if (!this.approval) return;
    const { resolve, input } = this.approval;
    this.approval = null;
    this.bus.emit('plan_approved', {} as never);
    resolve({ behavior: 'allow', updatedInput: input });
    void this.q?.setPermissionMode('acceptEdits');
  }

  private rejectPlan(feedback: string) {
    if (!this.approval) return;
    const { resolve } = this.approval;
    this.approval = null;
    resolve({ behavior: 'deny', message: `The user did not approve the plan yet. Their feedback: ${feedback}` });
  }

  private onPlan(steps: PlanStep[], violations: Violation[]) {
    if (!this.turn) return;
    this.turn.planned = true;
    this.turn.steps = steps;
    this.turn.planViolations = violations;
  }

  private onResult(subtype: string) {
    this.busy = false;
    this.ephemeral({ type: 'busy', busy: false });
    const turn = this.turn;
    if (!turn) return;
    if (subtype !== 'success') this.bus.emit('error', { message: `Turn ended with ${subtype}` });
    // Only undecided violations are forks; decision-backed ones were answered before (beat 4) and never re-asked.
    const open = splitDecided([...turn.planViolations, ...turn.gateBlocks]).open;
    if (open.length && subtype === 'success') {
      // Claude stopped to ask: the turn stays open until the user answers.
      turn.forkOpen = open;
      this.bus.emit('fork_asked', { violations: open, text: turn.lastText });
      return;
    }
    this.endTurn(subtype);
  }

  private endTurn(reason: string) {
    const turn = this.turn!;
    const stat = numstat(this.repo.root, turn.base);
    this.bus.emit('turn_ended', { ...stat, reason });
    // Beat 4: a decision made this turn now protects what the turn built for it (deterministic; commits the DR file).
    try { recordProtects(this.repo, this.bus, turn.id); }
    catch (e) { this.bus.emit('error', { message: `Could not record what the decision protects: ${(e as Error).message}` }); }
    const events = this.bus.events.filter((e) => e.turn === turn.id);
    writeFileSync(join(this.repo.root, '.harness/turns', `${turn.id}.json`), JSON.stringify({ id: turn.id, prompt: turn.prompt, baseline: turn.base, steps: turn.steps, numstat: stat, events }, null, 2));
    this.turn = null;
    this.bus.turn = null;
    this.repo.recheck();
    void this.q?.setPermissionMode('plan');
  }

  // ---------------------------------------------------------------- hooks

  private observeRead: HookCallback = async (input) => {
    const i = input as PreToolUseHookInput;
    const ti = i.tool_input as { file_path?: string; path?: string };
    if (i.tool_name === 'Read' && ti.file_path) {
      const rel = this.repo.rel(ti.file_path);
      if (rel) this.bus.emit('looked', { tool: 'Read' }, { path: rel, cell: this.repo.cellOf(rel) });
    } else {
      const rel = this.repo.rel(ti.path ?? this.repo.root);
      if (rel) this.bus.emit('cursor', { verb: 'searching' }, { path: rel, cell: this.repo.cellOf(rel) ?? this.repo.cellForDir(rel) });
    }
    return { async: true };
  };

  /** Claude often reads with `cat`/`sed`/`grep` in Bash: any repo file named in the command counts as looked at. */
  private observeBash: HookCallback = async (input) => {
    const cmd = String((input as PreToolUseHookInput & { tool_input: { command?: string } }).tool_input.command ?? '');
    if (/(^|[;&|]\s*)(cat|head|tail|sed|grep|rg|less|wc|nl|awk)\b/.test(cmd)) {
      for (const token of new Set(cmd.split(/[\s'";|&()<>]+/))) {
        const rel = /[\w-]\.\w+$/.test(token) ? this.repo.rel(token) : null;
        if (rel && this.repo.facts.files.includes(rel)) this.bus.emit('looked', { tool: 'Bash' }, { path: rel, cell: this.repo.cellOf(rel) });
      }
    }
    return { async: true };
  };

  /**
   * Edits made through Bash (heredocs, `sed -i`, inline scripts) would skip the edit gate. Deny commands that
   * write files inside the repo and ask for Edit/Write instead; tests, git and reads pass. The watcher still
   * records anything that slips through, as an unattributed edit.
   */
  private gateBash: HookCallback = async (input) => {
    const cmd = String((input as PreToolUseHookInput & { tool_input: { command?: string } }).tool_input.command ?? '');
    const target = bashWriteTarget(cmd, (p) => this.repo.rel(p));
    if (!target) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Interpretability: change files in this repo with the Edit or Write tool, not through Bash (${target}), so every edit can be checked against the architecture rules. Make this change with Edit/Write instead.`,
      },
    };
  };

  /** The edit gate: same checker as load and plan, on the imports/writes this edit would add. */
  private gate: HookCallback = async (input) => {
    const i = input as PreToolUseHookInput;
    const ti = i.tool_input as { file_path?: string; content?: string; old_string?: string; new_string?: string; replace_all?: boolean };
    if (!ti.file_path) return {};
    const rel = this.repo.rel(ti.file_path);
    if (!rel) return {}; // outside the repo, e.g. Claude's own plan file
    const old = this.repo.current(rel);
    let next: string;
    try {
      next = i.tool_name === 'Write' ? ti.content ?? '' : applyEdit(old ?? '', ti.old_string ?? '', ti.new_string ?? '', ti.replace_all);
    } catch {
      return {}; // the Edit will fail on its own
    }
    const delta = deltaForEdit(rel, old, next, withExtra(this.repo.exists, [rel]));
    const violations = check(this.repo.map, delta, this.repo.mapper);
    this.bus.emit('cursor', { verb: 'editing' }, { path: rel, cell: this.repo.cellOf(rel) });
    if (!violations.length) {
      this.repo.markPending(rel);
      return {};
    }
    for (const v of violations) this.bus.emit('gate_blocked', { violation: v, tool: i.tool_name }, { path: rel, cell: this.repo.cellOf(rel) });
    this.turn?.gateBlocks.push(...violations);
    const { open, decided } = splitDecided(violations);
    const why = [
      'Interpretability blocked this edit.',
      ...(open.length ? [violationText(open), ASK_RULE] : []),
      ...(decided.length ? [...decided.map((v) => v.reason), decidedText(this.repo.root, decided)] : []),
    ];
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: why.join('\n'),
      },
    };
  };

  /**
   * After an Edit/Write: record it (lines, symbols, facts, edges) synchronously, then check the symbol diff against
   * every standing decision's protected code (beat 4). A touch emits `decision_touched { source: 'edit' }` and, once
   * per decision per turn, returns the reminder as `additionalContext` (honored on synchronous hook responses only).
   */
  private afterEdit: HookCallback = async (input) => {
    const i = input as PostToolUseHookInput;
    const ti = i.tool_input as { file_path?: string };
    const rel = ti.file_path ? this.repo.rel(ti.file_path) : null;
    if (!rel) return {};
    const change = this.repo.fileChanged(rel, { tool: i.tool_name });
    if (!change) return {};
    const fresh = editTouchesFor(this.repo, this.bus, rel, change.symbols).filter((t) => !this.turn?.reminded.has(t.id));
    if (!fresh.length) return {};
    for (const t of fresh) this.turn?.reminded.add(t.id);
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: fresh.map((t) => t.text).join('\n') } };
  };

  private afterAlike: HookCallback = async (input) => {
    const i = input as PostToolUseHookInput;
    const res = JSON.stringify(i.tool_response ?? '');
    const ids = new Set(JSON.stringify(i.tool_input).match(/DR-\d+/g) ?? []);
    if (/error|failed|unauthori[sz]ed/i.test(res) && !/"id"/.test(res)) return { async: true };
    for (const d of this.bus.events.filter((e) => e.kind === 'decision_recorded')) {
      const data = d.data as { id: string };
      if (ids.has(data.id)) this.bus.emit('decision_recorded', { ...(d.data as EventData['decision_recorded']), alike: true });
    }
    return { async: true };
  };

  private canUseTool: CanUseTool = async (name, input) => {
    if (name === 'ExitPlanMode') {
      const turn = this.turn;
      if (turn && !turn.planned) {
        return { behavior: 'deny', message: 'Call mcp__interpretability__submit_plan with your numbered steps before exiting plan mode.' };
      }
      if (turn?.planViolations.length) {
        const { open, decided } = splitDecided(turn.planViolations);
        if (open.length) return { behavior: 'deny', message: `The plan has unresolved violations.\n${violationText(open)}\n${ASK_RULE}` };
        return { behavior: 'deny', message: `The plan crosses a decided rule.\n${decidedText(this.repo.root, decided)}\nResubmit the plan with mcp__interpretability__submit_plan.` };
      }
      const plan = String((input as { plan?: unknown }).plan ?? '');
      this.bus.emit('approval_requested', { plan });
      return new Promise<PermissionResult>((resolve) => { this.approval = { resolve, input }; });
    }
    return { behavior: 'allow', updatedInput: input };
  };

  interrupt() { void this.q?.interrupt(); }
}
