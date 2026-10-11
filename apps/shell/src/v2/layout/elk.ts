// The browser's ELK: elkjs's own worker script, loaded on the first layout only (v1 never pulls it in).
import type { ElkNode } from 'elkjs/lib/elk-api';
import { cachedLayout, type ElkApi } from './containers';

let elk: Promise<ElkApi> | null = null;

function getElk(): Promise<ElkApi> {
  elk ??= Promise.all([import('elkjs/lib/elk-api.js'), import('elkjs/lib/elk-worker.min.js?url')]).then(([api, url]) => {
    const ELK = api.default;
    return new ELK({ workerFactory: () => new Worker(url.default) }) as unknown as ElkApi;
  });
  return elk;
}

export const layoutContainer = cachedLayout(getElk);
export const clearLayoutCache = () => layoutContainer.cache.clear();

/** Boot the worker and JIT ELK before the first expand (the cold first layout took ~160 ms on the M1). */
export const warmElk = () =>
  getElk().then((api) => api.layout({ id: 'warm', layoutOptions: { 'elk.algorithm': 'layered' }, children: [{ id: 'a', width: 10, height: 10 }, { id: 'b', width: 10, height: 10 }], edges: [{ id: 'e', sources: ['a'], targets: ['b'] }] } as ElkNode));
