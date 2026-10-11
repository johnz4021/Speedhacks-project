import { useEffect, useLayoutEffect, useRef } from 'react';
import { api, fakeMode } from '../connection';
import { useView } from '../derive';
import { useStore } from '../store';
import { Markdown } from './Markdown';

export function ChatPane() {
  const v = useView();
  const delta = useStore((s) => s.delta);
  const busy = useStore((s) => s.busy);
  const conn = useStore((s) => s.conn);
  const scroller = useRef<HTMLDivElement>(null);
  const chat = v.ui.chat;
  const replaying = !v.live;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length, delta, v.ui.errors.length, v.ui.pendingFork, v.ui.awaitingApproval]);

  const empty = !chat.length && !delta;
  return (
    <aside className="chat">
      <div className="chat-head">
        <span className="chat-title">Claude Code</span>
        <span className={`chat-state ${busy ? 'is-busy' : ''}`}>
          {replaying ? 'Replaying' : conn === 'down' ? 'Offline' : busy ? 'Working' : 'Ready'}
        </span>
      </div>

      <div className="chat-log" ref={scroller}>
        {empty && (
          <div className="chat-empty">
            <p>Ask Claude to change something. The map shows what it plans and what it does.</p>
            <p className="chat-example">“Add a tool that summarizes a prospect's latest 10-K.”</p>
          </div>
        )}
        {chat.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}`}>
            {m.role === 'assistant' ? <Markdown text={m.text} /> : <p>{m.text}</p>}
          </div>
        ))}
        {busy && v.live && delta && (
          <div className="msg msg-assistant msg-streaming">
            <Markdown text={delta} />
          </div>
        )}
        {v.ui.errors.map((e, i) => (
          <div key={`e${i}`} className="msg msg-note">{e}</div>
        ))}
      </div>

      {v.ui.pendingFork && <ForkCard />}
      {v.ui.awaitingApproval && !v.ui.pendingFork && <ApprovalCard plan={v.ui.awaitingApproval.plan} disabled={replaying} />}
      <Composer disabled={replaying || conn === 'down'} busy={busy && v.live} why={replaying ? 'Replaying. Go live to send.' : 'Waiting for the server.'} />
    </aside>
  );
}

function ForkCard() {
  const v = useView();
  const setDraft = useStore((s) => s.setDraft);
  const fork = v.ui.pendingFork!;
  const first = fork.violations[0];
  if (!first) return null;
  return (
    <section className="card card-fork" aria-label="Choose how to proceed">
      <p className="card-kicker">{first.invariant} would be crossed</p>
      <p className="card-reason">{first.reason}</p>
      <div className="fork-options">
        {(['A', 'B'] as const).map((opt, i) => (
          <button key={opt} className="fork-option" disabled={!v.live} onClick={() => setDraft(`${opt} — `, true)}>
            <span className="fork-letter">{opt}</span>
            <span>{first.options[i]}</span>
          </button>
        ))}
      </div>
      <p className="card-hint">Pick one and add your reason. It becomes a decision later sessions follow.</p>
    </section>
  );
}

function ApprovalCard({ plan, disabled }: { plan: string; disabled: boolean }) {
  return (
    <section className="card card-approve" aria-label="Plan waiting for approval">
      <p className="card-kicker">Plan ready</p>
      {plan.trim() && (
        <div className="card-plan">
          <Markdown text={plan} />
        </div>
      )}
      <div className="card-actions">
        <button className="btn btn-primary" disabled={disabled} onClick={() => void api.approve()}>Approve plan</button>
        <span className="card-hint">or reply with changes</span>
      </div>
    </section>
  );
}

function Composer({ disabled, busy, why }: { disabled: boolean; busy: boolean; why: string }) {
  const draft = useStore((s) => s.draft);
  const focusTick = useStore((s) => s.focusTick);
  const setDraft = useStore((s) => s.setDraft);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ta.current;
    if (!el || !focusTick) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusTick]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, [draft]);

  const send = () => {
    const t = draft.trim();
    if (!t || disabled) return;
    void api.chat(t);
    setDraft('');
  };

  return (
    <div className="composer">
      <textarea
        ref={ta}
        rows={1}
        value={draft}
        disabled={disabled}
        placeholder={disabled ? why : fakeMode ? 'Fake log loaded; sending is off.' : 'Message Claude'}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
      />
      {busy ? (
        <button className="btn btn-stop" onClick={() => void api.interrupt()}>Stop</button>
      ) : (
        <button className="btn btn-primary" disabled={disabled || !draft.trim()} onClick={send}>Send</button>
      )}
    </div>
  );
}
