import type { HarnessEvent } from '@harness/core/view';
import { useStore } from './store';

type ServerMsg =
  | { type: 'hello'; events: HarnessEvent[]; busy: boolean; session: string }
  | { type: 'event'; event: HarnessEvent }
  | { type: 'delta'; text: string }
  | { type: 'busy'; busy: boolean };

const params = new URLSearchParams(location.search);
/** Dev-only: `?fake=1` loads /fake-events.json at once, `?fake=play` streams it; `&at=N` opens the replay at N. */
export const fakeMode = params.get('fake');

export function connect() {
  if (fakeMode) return loadFake(fakeMode === 'play');
  void fetch('/api/info')
    .then((r) => r.json() as Promise<{ repo: string }>)
    .then((i) => useStore.getState().setRepo(i.repo))
    .catch(() => {});
  openSocket(500);
}

function openSocket(delay: number) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  let opened = false;
  ws.onopen = () => {
    opened = true;
    useStore.getState().setConn('open');
  };
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data)) as ServerMsg;
    const s = useStore.getState();
    if (msg.type === 'hello') s.hello(msg.events, msg.busy);
    else if (msg.type === 'event') s.append(msg.event);
    else if (msg.type === 'delta') s.addDelta(msg.text);
    else if (msg.type === 'busy') s.setBusy(msg.busy);
  };
  ws.onclose = () => {
    useStore.getState().setConn('down');
    const next = opened ? 500 : Math.min(delay * 2, 8000);
    setTimeout(() => openSocket(next), opened ? 500 : delay);
  };
}

async function loadFake(play: boolean) {
  const st = useStore.getState();
  st.setConn('fake');
  st.setRepo('scout-agent (fake turn)');
  const events = (await (await fetch('/fake-events.json')).json()) as HarnessEvent[];
  const at = params.get('at');
  if (!play) {
    st.hello(events, false);
    if (at !== null) st.setReplay(Math.max(0, Math.min(events.length, Number(at))));
    return;
  }
  st.hello([], false);
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const prev = events[i - 1];
    const gap = prev ? Math.max(20, Math.min(900, (e.t - prev.t) / 3)) : 0;
    await new Promise((r) => setTimeout(r, e.kind === 'file_assigned' ? 15 : gap));
    useStore.getState().append(e);
  }
}

async function post(path: string, body?: unknown) {
  if (fakeMode) return;
  await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
}

export const api = {
  chat: (text: string) => post('/api/chat', { text }),
  approve: () => post('/api/approve'),
  interrupt: () => post('/api/interrupt'),
  confirmMap: () => post('/api/map/confirm'),
  fallbackMap: () => post('/api/map/fallback'),
  async file(path: string): Promise<string | null> {
    const r = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
    return r.ok ? r.text() : null;
  },
};
