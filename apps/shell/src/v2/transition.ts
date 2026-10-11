// Staged, interruptible transitions between two laid-out frames (NAVIGATION_PLAN §3.3):
//   0–150 ms   fade out edges that will change and nodes that will go
//   150–450 ms one commit, then FLIP the moved nodes with the Web Animations API; the camera flies in parallel
//   450–650 ms new nodes fade in and changed edges draw in (CSS, keyed on the commit)
// A new request at any point cancels the pending stage and starts from what is on screen.
import type { Frame } from './layout/grid';

export const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const T_FADE = 150;
export const T_MOVE = 300;
export const T_ENTER = 200;
const EASE = 'cubic-bezier(0.25, 0.8, 0.3, 1)';
const FADE_ID = 'v2-fade';

export type Enter = { nodes: Set<string>; edges: Set<string>; seq: number };
export type TransitionStats = { commitMs: number; commitToFrameMs: number; moved: number; entered: number; removed: number; animated: boolean };

export type TransitionHooks = {
  root(): HTMLElement | null;
  /** Must commit synchronously (flushSync): content and positions land in one React commit. */
  commit(next: Frame, enter: Enter): void;
  camera(next: Frame, prev: Frame | null, animate: boolean): void;
};

const sel = (attr: string, id: string) => `[${attr}="${CSS.escape(id)}"]`;

export class Transitioner {
  private timers: number[] = [];
  private seq = 0;
  shown: Frame | null = null;
  last: TransitionStats | null = null;
  onDone: ((s: TransitionStats) => void) | null = null;

  constructor(private hooks: TransitionHooks) {}

  cancel() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    const root = this.hooks.root();
    if (!root) return;
    for (const a of root.getAnimations({ subtree: true })) {
      if (a.id === FADE_ID) a.cancel();
      else if (a instanceof CSSAnimation || a instanceof CSSTransition) continue;
      else a.finish();
    }
  }

  go(next: Frame) {
    this.cancel();
    const prev = this.shown;
    const root = this.hooks.root();
    const animate = !!prev && !!root && !reducedMotion();
    const prevEdges = new Map(prev?.edges.map((e) => [e.id, e.d]) ?? []);
    const nextEdges = new Map(next.edges.map((e) => [e.id, e.d]));
    const changedEdges = [...prevEdges].filter(([id, d]) => nextEdges.get(id) !== d).map(([id]) => id);
    const removed = prev ? prev.nodes.filter((n) => !next.boxes[n.id]).map((n) => n.id) : [];
    const enter: Enter = {
      nodes: new Set(prev ? next.nodes.filter((n) => !prev.boxes[n.id]).map((n) => n.id) : []),
      edges: new Set(prev ? next.edges.filter((e) => prevEdges.get(e.id) !== e.d).map((e) => e.id) : []),
      seq: ++this.seq,
    };

    if (animate && root) {
      for (const id of changedEdges) root.querySelector(sel('data-edge', id))?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: T_FADE, fill: 'forwards', easing: 'ease-out', id: FADE_ID });
      for (const id of removed) root.querySelector(`.react-flow__node${sel('data-id', id)}`)?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: T_FADE, fill: 'forwards', easing: 'ease-out', id: FADE_ID });
    }
    const run = () => this.commit(prev, next, enter, animate, removed.length);
    if (animate && (changedEdges.length || removed.length)) this.timers.push(window.setTimeout(run, T_FADE));
    else run();
  }

  private commit(prev: Frame | null, next: Frame, enter: Enter, animate: boolean, removed: number) {
    const root = this.hooks.root();
    if (root) for (const a of root.getAnimations({ subtree: true })) if (a.id === FADE_ID) a.cancel();
    const t0 = performance.now();
    this.hooks.commit(next, enter);
    const commitMs = performance.now() - t0;
    this.shown = next;

    let moved = 0;
    if (animate && prev && root) {
      for (const n of next.nodes) {
        const a = prev.boxes[n.id];
        if (!a) continue;
        const posChanged = Math.abs(a.x - n.x) > 0.5 || Math.abs(a.y - n.y) > 0.5;
        const sizeChanged = Math.abs(a.w - n.w) > 0.5 || Math.abs(a.h - n.h) > 0.5;
        if (!posChanged && !sizeChanged) continue;
        const el = root.querySelector<HTMLElement>(`.react-flow__node${sel('data-id', n.id)}`);
        if (!el) continue;
        moved++;
        const from: Keyframe = { transform: `translate(${a.x}px, ${a.y}px)` };
        const to: Keyframe = { transform: `translate(${n.x}px, ${n.y}px)` };
        if (sizeChanged) Object.assign(from, { width: `${a.w}px`, height: `${a.h}px` }), Object.assign(to, { width: `${n.w}px`, height: `${n.h}px` });
        el.animate([from, to], { duration: T_MOVE, easing: EASE });
      }
    }
    this.hooks.camera(next, prev, animate);
    const stats: TransitionStats = { commitMs, commitToFrameMs: 0, moved, entered: enter.nodes.size, removed, animated: animate };
    requestAnimationFrame(() => {
      stats.commitToFrameMs = performance.now() - t0;
      this.last = stats;
      const done = () => this.onDone?.(stats);
      if (animate) this.timers.push(window.setTimeout(done, T_MOVE + T_ENTER));
      else done();
    });
  }
}
