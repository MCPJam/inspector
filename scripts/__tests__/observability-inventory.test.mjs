import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discover, writeReport } from '../observability-inventory.mjs';

function fixture(files, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp80-scanner-test-'));
  const inspector = path.join(dir, 'inspector'), backend = path.join(dir, 'backend');
  fs.mkdirSync(inspector); fs.mkdirSync(backend);
  for (const [file, contents] of Object.entries(files)) {
    const full = path.join(dir, file); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, contents);
  }
  try { run(discover(inspector, backend), dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
test('joins nested Hono mounts, resolves constants/arrays/helpers and retains inherited deployment conditions', () => fixture({
  'inspector/mcpjam-inspector/server/index.ts': `import routes from './routes/main.js'; import { mountOpenRoutes } from './open.js'; const app = new Hono(); if (!HOSTED_MODE) app.route('/api', routes); mountOpenRoutes(app); const map = new Map(); map.get('not-a-route');`,
  'inspector/mcpjam-inspector/server/routes/main.ts': `import { PATHS } from '../paths.js'; const router = new Hono(); for (const p of PATHS) router.get(p, c => c.json({ok:true})); export default router;`,
  'inspector/mcpjam-inspector/server/paths.ts': `export const PATHS = ['/one', '/two'] as const;`,
  'inspector/mcpjam-inspector/server/open.ts': `export function mountOpenRoutes(app: Hono) { app.get('/health', c => c.json({ok:true})); }`,
}, r => {
  const routes = r.rows.filter(x => x.kind === 'inspector.http');
  assert.deepEqual(routes.map(x => x.name).sort(), ['GET /api/one', 'GET /api/two', 'GET /health']);
  assert.deepEqual(routes.find(x => x.path === '/api/one').conditions, ['!HOSTED_MODE']);
  assert.equal(routes.find(x => x.path === '/health').status, 'gap');
  assert.equal(r.unresolved.length, 0);
}));
test('reports unresolved mounts and dynamic paths instead of dropping or verifying them', () => fixture({
  'inspector/mcpjam-inspector/server/index.ts': `const app = new Hono();
app.route('/external', unknownRouter());
app.route(computeMount(), router);
app.get(computePath(), handler);`,
}, r => {
  assert.equal(r.unresolved.length, 3);
  assert.deepEqual(r.unresolved.map(({ reason, line }) => ({ reason, line })).sort((a, b) => a.line - b.line), [
    { reason: 'unresolved router mount', line: 2 },
    { reason: 'dynamic mount', line: 3 },
    { reason: 'dynamic route path/method', line: 4 },
  ]);
  assert.equal(r.rows.filter(x => x.verified).length, 0);
}));
test('expands finite template/conditional route loops without inventing unreachable branches', () => fixture({
  'inspector/mcpjam-inspector/server/index.ts': "const app = new Hono(); for(const operation of ['update','read','remove'] as const) app.post(operation === 'update' ? '/context' : `/context/${operation}`, handler); for(const p of ['', '/label']) app.post(p || '/', handler);",
}, r => {
  assert.deepEqual(r.rows.filter(x => x.kind === 'inspector.http').map(x => x.path).sort(), ['/', '/context', '/context/read', '/context/remove', '/label']);
  assert.equal(r.unresolved.length, 0);
}));
test('resolves default factory routers and prevents cyclic router traversal', () => fixture({
  'inspector/mcpjam-inspector/server/index.ts': `import routes from './routes/main.js'; const app = new Hono(); app.route('/api', routes);`,
  'inspector/mcpjam-inspector/server/routes/main.ts': `function makeRoutes(){ const app = new Hono(); app.get('/ok',handler); app.route('/loop',app); return app; } export default makeRoutes();`,
}, r => {
  assert.equal(r.rows.filter(x => x.kind === 'inspector.http').length, 1);
}));
test('finds wrapped Convex functions, registration and alternate durable/scheduled writers without executing code', () => fixture({
  'backend/convex/example.ts': `throw new Error('Do not execute me'); export const userQuery = customQuery(query,{}); export const read = userQuery({handler: async ctx => null}); export const write = internalMutation({handler: async ctx => {await ctx.db.patch(id,{status:'failed'}); await ctx.scheduler.runAfter(0,internal.jobs.recover,{});}}); const notRegistered = userQuery({});`,
  'backend/convex/http.ts': `http.route({path:'/v1/work',method:'POST',handler:httpAction(async () => new Response('ok'))});`,
  'backend/convex/crons.ts': `crons.interval('recover',{minutes:5},internal.jobs.recover,{});`,
  'backend/convex/__tests__/ignored.ts': `export const fake = query({});`,
}, r => {
  assert.equal(r.counts['convex.function.query'], 1);
  assert.equal(r.counts['convex.function.mutation'], 1);
  assert.equal(r.counts['convex.http'], 1);
  assert.equal(r.counts['convex.cron'], 1);
  assert.equal(r.counts['durable.writer.candidate'], 1);
  assert.equal(r.counts['convex.scheduled'], 1);
  assert.ok(r.rows.every(x => x.verified === false));
}));
test('expands Convex shorthand registrations and template paths in loops', () => fixture({
  'backend/convex/http.ts': "const ROOT='/internal'; for(const path of ['/one','/two']) http.route({path,method:'POST',handler}); for(const suffix of ['read','write']) http.route({path:`${ROOT}/${suffix}`,method:'OPTIONS',handler});",
}, r => {
  assert.deepEqual(r.rows.filter(x => x.kind === 'convex.http').map(x => x.path).sort(), ['/internal/read', '/internal/write', '/one', '/two']);
  assert.equal(r.unresolved.length, 0);
}));
test('records SDK catalog, browser hooks and product surfaces; serialized outputs preserve unknowns', () => fixture({
  'inspector/sdk/src/platform/operations.ts': `export const listProjects: PlatformOperation<Input,Output> = {name:'list_projects',execute(){}};`,
  'inspector/mcpjam-inspector/client/src/view.tsx': `const items = useQuery(api.items.list); export const view = <ErrorBoundary><Screen/></ErrorBoundary>;`,
  'inspector/mcpjam-inspector/client/src/lib/app-routes.ts': `export const APP_ROUTES = [{path:'projects',kind:'screen',surfaceId:'projects',scope:'global'}];`,
  'inspector/mcp/src/index.ts': `export default {async fetch(request:Request){return new Response('ok');}};`,
}, (r, dir) => {
  assert.equal(r.counts['sdk.operation'], 1);
  assert.equal(r.counts['browser.request.candidate'], 1);
  assert.equal(r.counts['react.error-boundary'], 1);
  assert.equal(r.counts['product.screen'], 1);
  assert.equal(r.counts['mcp.http-handler'], 1);
  writeReport(r, path.join(dir, 'report'));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'report/inventory.json')));
  assert.equal(saved.rows.find(x => x.kind === 'product.screen').status, 'unknown');
  assert.match(fs.readFileSync(path.join(dir, 'report/inventory.csv'), 'utf8'), /"list_projects"/);
}));
