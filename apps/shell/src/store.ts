import { create } from 'zustand';
import type { HarnessEvent } from '@harness/core/view';

/** What the inspector shows: a cell, a v1 domain edge (cell pair), Unassigned; and in v2 a file, any other node, or a drawn edge. */
export type Selection =
  | { cell: string }
  | { edge: string; pair: string }
  | { unassigned: true }
  | { file: string }
  | { node: string }
  | { link: string };

export type Conn = 'connecting' | 'open' | 'down' | 'fake';

/**
 * The store holds the event log and purely ephemeral UI state. Everything the map, ledger, summary and chat show
 * is derived from `events` (see derive.ts); nothing here is a second copy of footprint, ghosts or ledger.
 */
type Store = {
  events: HarnessEvent[];
  /** null = live; otherwise the number of events to reduce (replay). */
  replay: number | null;
  /** Streaming assistant text not yet committed as a `chat` event. */
  delta: string;
  busy: boolean;
  conn: Conn;
  repo: string;
  draft: string;
  focusTick: number;
  selection: Selection | null;
  /** null = latest turn. */
  turn: string | null;
  hover: string | null;

  hello(events: HarnessEvent[], busy: boolean): void;
  append(e: HarnessEvent): void;
  addDelta(text: string): void;
  setBusy(b: boolean): void;
  setConn(c: Conn): void;
  setRepo(r: string): void;
  setDraft(d: string, focus?: boolean): void;
  select(s: Selection | null): void;
  setTurn(id: string | null): void;
  setReplay(i: number | null): void;
  setHover(h: string | null): void;
};

export const useStore = create<Store>((set) => ({
  events: [],
  replay: null,
  delta: '',
  busy: false,
  conn: 'connecting',
  repo: '',
  draft: '',
  focusTick: 0,
  selection: null,
  turn: null,
  hover: null,

  hello: (events, busy) => set({ events, busy, delta: '' }),
  append: (e) =>
    set((s) => {
      if (s.events.length && s.events[s.events.length - 1]!.id === e.id) return s;
      const clear = e.kind === 'chat' && (e.data as { role?: string } | undefined)?.role === 'assistant';
      return { events: [...s.events, e], ...(clear ? { delta: '' } : {}) };
    }),
  addDelta: (text) => set((s) => ({ delta: s.delta + text })),
  setBusy: (busy) => set(busy ? { busy } : { busy, delta: '' }),
  setConn: (conn) => set({ conn }),
  setRepo: (repo) => set({ repo }),
  setDraft: (draft, focus) => set((s) => ({ draft, focusTick: focus ? s.focusTick + 1 : s.focusTick })),
  select: (selection) => set({ selection }),
  setTurn: (turn) => set({ turn }),
  setReplay: (replay) => set({ replay }),
  setHover: (hover) => set({ hover }),
}));
