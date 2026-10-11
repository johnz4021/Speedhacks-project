# Step 0: verification results

SDK `@anthropic-ai/claude-agent-sdk@0.3.296`, Claude Code login (no API key; `apiKeySource: none`), model `claude-opus-5-5`. Script: `apps/server/src/verify.ts` (`npm run verify -w @harness/server -- a|d|d2`). Run 2026-10-11.

| Check | Result | Notes |
| --- | --- | --- |
| (a) custom MCP tool callable in plan mode | **Pass** | `mcp__harness__submit_plan` ran with `permission_mode: plan`. In plan mode the call still goes to `canUseTool` even though it is in `allowedTools`, so `canUseTool` must allow `mcp__harness__*`. Without `alwaysLoad: true` on the tool, Claude has to `ToolSearch` for it first. |
| (b) `canUseTool` receives `ExitPlanMode` | **Pass** | Allowing it and calling `q.setPermissionMode('acceptEdits')` lets the build proceed. No fallback needed. |
| (c) after a hook deny with "ask the user", Claude asks | **Pass** | Deny reason naming A/B and "do not try another route" → Claude stopped, asked A/B in one message, made zero further tool calls. Twice in a row. |
| (d) Alike MCP available in an SDK session | **Pass** | After `/mcp` → alike → sign in, SDK sessions get it both from user config and passed explicitly (`mcpServers.alike = { type: 'http', url }` with `settingSources: ['project','local']`, so Alike's hooks stay off). `describe_entity_kind` returned the decision schema. Caveat: the first sign-in did not survive a Claude Code restart, and before it every non-interactive session (SDK and `claude -p`) reported `needs-auth`. Re-run `-- d2` before the demo. Fallback: the paired `~/.alike/bin/alike` CLI can call `record_decision` without MCP. |

## Things the build must handle

1. **Plan files live outside the repo.** In plan mode Claude writes its plan to `~/.claude/plans/<name>.md` with `Write`. The edit gate and footprint must ignore any path outside the target repo.
2. **Paths come back realpath'd.** On macOS the SDK reports `/private/var/...` for a cwd under `/var/...`. Normalize hook paths with `realpath` before making them repo-relative.
3. **`AskUserQuestion`.** After a deny, Claude prefers the `AskUserQuestion` tool, which arrives at `canUseTool`. Harness passes `disallowedTools: ['AskUserQuestion']`, so the question comes as chat text, which is where the fork UI lives.
4. **Alike's user-level hooks.** With default `settingSources`, the hooks `@alikeai/setup` put in `~/.claude/settings.json` fire inside Harness sessions (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolBatch, Stop). That's a network call in the hot path. Harness uses `settingSources: ['project', 'local']`, which drops them, along with user-scope MCP servers. Alike is then passed explicitly as `mcpServers.alike = { type: 'http', url }`. Whether that copy can reuse the stored OAuth token is part of (d).
5. **Alike's `record_decision` arguments:** `title`, `outcome`, `rationale`, `decision_type` (`standing`), `status` (`made`), `anchors: [{ kind: 'path', label: 'governs', path, repository: 'owner/name' }]`. There is no branch field on path anchors. Harness hands Claude the exact JSON, so no `describe_entity_kind` call is needed per session.
6. **`planModeInstructions` exists** (`Options.planModeInstructions`), replacing the default plan-mode workflow body. Harness uses it for the submit_plan rules instead of only the appended system prompt.
