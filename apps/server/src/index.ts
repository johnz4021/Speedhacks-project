import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { WebSocketServer, type WebSocket } from 'ws';
import { Bus } from './bus';
import { Repo } from './repo';
import { Session } from './session';
import { commitPaths } from './git';
import { attachLivingMap, livingMapRoutes, onboardingSkeleton, proposeOnboarding, sdkProposer } from './living-map'; // living map (NAVIGATION_PLAN §4)
import { attachSemantic } from './semantic'; // Tier 2 semantic facts (NAVIGATION_PLAN §3.1)

const here = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.HARNESS_REPO ? resolve(process.env.INIT_CWD ?? process.cwd(), process.env.HARNESS_REPO) : '';
if (!REPO || !existsSync(REPO)) {
  console.error(`Set HARNESS_REPO to the target repo (got "${process.env.HARNESS_REPO ?? ''}").`);
  process.exit(1);
}
const PORT = Number(process.env.PORT ?? 4310);
const FALLBACK_MAP = resolve(here, '../../../fixtures/scout-agent.domains.yaml');

const bus = new Bus(REPO, { fresh: process.env.HARNESS_FRESH === '1' });
const sockets = new Set<WebSocket>();
const broadcast = (msg: unknown) => {
  const s = JSON.stringify(msg);
  for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(s);
};
bus.on((event) => broadcast({ type: 'event', event }));

const repo = new Repo(REPO, bus);
// Tier 2 runs in a child process fed by repo_scanned / facts_changed; its status is ephemeral (not in the log).
const semantic = attachSemantic(bus, repo, { onStatus: (status) => broadcast({ type: 'semantic', status }), log: (l) => console.log(l) });
let session: Session | null = null;
let proposal: { yaml: string; source: 'cartographer' | 'fixture' } | null = null;
let busy = false;

function startSession() {
  repo.scan();
  repo.startWatcher();
  session = new Session(repo, bus, (m) => {
    if (m.type === 'busy') busy = m.busy;
    broadcast(m);
  });
  session.start();
}

/**
 * Load: use domains.yaml if present. Otherwise show the instant skeleton, then the best of the cartographer's K scored
 * candidates (HARNESS_CARTOGRAPHER=0, or a failed/empty run: the reference map), and wait for Confirm.
 */
async function load() {
  if (repo.hasMap()) {
    repo.loadMapFile();
    bus.emit('map_confirmed', { map: repo.map, source: 'file' }, { turn: null });
    startSession();
    return;
  }
  // ---- living map: the instant deterministic skeleton while the cartographer works (NAVIGATION_PLAN §4.2) ----
  showProposal(onboardingSkeleton(repo.root), 'cartographer');
  let yaml: string;
  let source: 'cartographer' | 'fixture' = 'cartographer';
  try {
    if (process.env.HARNESS_CARTOGRAPHER === '0') throw new Error('disabled');
    const k = Number(process.env.HARNESS_CARTOGRAPHER_K ?? 4);
    const best = await proposeOnboarding({ root: repo.root, bus, proposer: sdkProposer, k });
    if (!best) throw new Error('no valid candidate map');
    yaml = best.yaml;
    const s = best.score;
    bus.emit('chat', {
      role: 'system',
      text: `Cartographer: best of ${best.scored} scored candidate map(s): ${best.candidate.title} · a typical commit lights ${s.cellsLitMean.toFixed(1)} cells (skeleton ${best.skeleton.cellsLitMean.toFixed(1)}); ${s.unassigned} files unassigned.`,
    }, { turn: null });
  } catch (e) {
    if ((e as Error).message !== 'disabled') bus.emit('error', { message: `Cartographer failed, using the reference map: ${(e as Error).message}` }, { turn: null });
    yaml = readFileSync(FALLBACK_MAP, 'utf8');
    source = 'fixture';
  }
  // ---- end living map ----
  if (session) return; // the user confirmed the skeleton before the cartographer answered
  showProposal(yaml, source);
}

function showProposal(yaml: string, source: 'cartographer' | 'fixture') {
  repo.setMap(yaml);
  proposal = { yaml, source };
  bus.emit('map_proposed', { map: repo.map, yaml }, { turn: null });
  // The shell plays the map assembling: one file_assigned per file, ~15 ms apart.
  const files = repo.listFiles();
  files.forEach((path, i) => setTimeout(() => bus.emit('file_assigned', { placement: repo.place(path) }, { path, turn: null }), i * 15));
}

const app = new Hono();

// ---- living map (NAVIGATION_PLAN §4): drift → cartographer proposals, accept/reject, survey ----
const living = attachLivingMap({ bus, repo });
app.route('/api', livingMapRoutes(living));
// ---- end living map ----
app.get('/api/info', (c) => c.json({ repo: REPO, session: bus.session, busy, proposal: !!proposal }));
app.get('/api/events', (c) => c.json(bus.events));
app.get('/api/semantic', (c) => c.json(semantic?.status() ?? { state: 'off' }));
app.post('/api/chat', async (c) => {
  const { text } = await c.req.json<{ text: string }>();
  if (!session) return c.json({ error: 'Confirm the map first.' }, 409);
  session.userMessage(text);
  return c.json({ ok: true });
});
app.post('/api/approve', (c) => { session?.approve(); return c.json({ ok: true }); });
app.post('/api/interrupt', (c) => { session?.interrupt(); return c.json({ ok: true }); });
app.post('/api/map/confirm', (c) => {
  if (!proposal) return c.json({ error: 'No proposal pending.' }, 409);
  writeFileSync(repo.mapPath, proposal.yaml);
  try { commitPaths(repo.root, ['domains.yaml'], 'docs: add domains.yaml architecture map'); }
  catch (e) { bus.emit('error', { message: `Could not commit domains.yaml: ${(e as Error).message}` }, { turn: null }); }
  repo.setMap(proposal.yaml);
  bus.emit('map_confirmed', { map: repo.map, source: proposal.source }, { turn: null });
  proposal = null;
  startSession();
  return c.json({ ok: true });
});
app.post('/api/map/fallback', (c) => {
  if (!proposal) return c.json({ error: 'No proposal pending.' }, 409);
  showProposal(readFileSync(FALLBACK_MAP, 'utf8'), 'fixture');
  return c.json({ ok: true });
});
app.get('/api/file', (c) => {
  const p = c.req.query('path') ?? '';
  const rel = repo.rel(p);
  if (!rel || !existsSync(join(repo.root, rel))) return c.json({ error: 'not found' }, 404);
  return c.text(readFileSync(join(repo.root, rel), 'utf8'));
});

const shellDist = resolve(here, '../../shell/dist');
if (existsSync(shellDist)) app.use('/*', serveStatic({ root: shellDist }));

const server = serve({ fetch: app.fetch, port: PORT }, () => console.log(`Harness server on http://localhost:${PORT} · repo ${REPO}`));
const wss = new WebSocketServer({ server: server as never, path: '/ws' });
wss.on('connection', (ws) => {
  sockets.add(ws);
  ws.send(JSON.stringify({ type: 'hello', events: bus.events, busy, session: bus.session }));
  ws.on('close', () => sockets.delete(ws));
});

void load();

const shutdown = async () => { await semantic?.close(); await repo.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
