import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function run(script, args = [], extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'preview-cleanup-'));
  const executable = (name, content) => writeFileSync(join(dir, name), content, { mode: 0o755 });
  for (const name of ['railway-env.sh', 'reap-preview-envs.sh']) {
    copyFileSync(new URL(name, import.meta.url), join(dir, name));
  }
  executable('curl', `#!${process.execPath}
const args = process.argv.slice(2);
const payload = JSON.parse(args.includes('--data') ? args[args.indexOf('--data') + 1] : '{}');
const url = args.at(-1);
const preview = (name) => ({node:{id:name,name,serviceInstances:{edges:[{node:{domains:{serviceDomains:[{domain:name+'.up.railway.app'}],customDomains:[]}}}]}}});
let body;
if (args.includes('--data')) {
  if (payload.query.includes('mutation D')) body = {data:{environmentDelete:process.env.DELETE_OK !== '0'}};
  else if (process.env.LIST_ERROR === '1') body = {errors:[{message:'Unauthorized'}]};
  else body = {data:{project:{environments:{edges:['production','staging','pr-1','pr-2','pr-be-3'].map(preview)}}}};
  process.stdout.write(JSON.stringify(body));
} else {
  body = url.includes('state=open') ? [] : {state:process.env.PR_STATE || 'closed',closed_at:'2020-01-01T00:00:00Z'};
  require('node:fs').writeFileSync(args[args.indexOf('-o')+1],JSON.stringify(body));
  process.stdout.write(process.env.PR_HTTP || '200');
}
`);
  executable('workos-cleanup.sh', '#!/bin/bash\nif [ "$1" = --count ]; then echo 10; exit 0; fi\nexit "${WORKOS_FAIL:-0}"\n');
  executable('railway-retry.sh', '#!/bin/bash\nprintf "%s\\n" "$*" >> "$DELETE_LOG"\n"$@"\n');
  const log = join(dir, 'deletes');
  try {
    const result = spawnSync('bash', [join(dir, script), ...args], {
      encoding: 'utf8', env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`, DELETE_LOG: log,
        RAILWAY_API_TOKEN:'test',RAILWAY_PROJECT_ID:'test',GITHUB_TOKEN:'test',
        INSPECTOR_REPO:'test/inspector',BACKEND_REPO:'test/backend',BACKEND_GITHUB_TOKEN:'test',
        STAGING_WORKOS_API_KEY:'test',DRY_RUN:'0',GRACE_MINUTES:'0',
        ...extra,
      },
    });
    let deletes = '';
    try { deletes = readFileSync(log, 'utf8'); } catch {}
    return {...result, deletes};
  } finally { rmSync(dir, { recursive:true, force:true }); }
}

test('targeted close deletes only its exact preview', () => {
  const r = run('reap-preview-envs.sh', [], {TARGET_ENVIRONMENT:'pr-1'});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.deletes, /delete pr-1\n/);
  assert.doesNotMatch(r.deletes, /pr-2|pr-be|production|staging/);
});
test('backend target deletes only the closed backend preview', () => {
  const r = run('reap-preview-envs.sh', [], {TARGET_ENVIRONMENT:'pr-be-3'});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.deletes, /delete pr-be-3\n/);
  assert.doesNotMatch(r.deletes, /delete pr-[12]/);
});
test('a reopened PR is preserved even if absent from the open-list snapshot', () => {
  const r = run('reap-preview-envs.sh', [], {TARGET_ENVIRONMENT:'pr-1',PR_STATE:'open'});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.deletes, '');
});
test('WorkOS failure prevents deletion and fails cleanup', () => {
  const r = run('reap-preview-envs.sh', [], {TARGET_ENVIRONMENT:'pr-1',WORKOS_FAIL:'1'});
  assert.equal(r.status, 1);
  assert.equal(r.deletes, '');
});
test('PR lookup failure never deletes an environment', () => {
  const r = run('reap-preview-envs.sh', [], {TARGET_ENVIRONMENT:'pr-1',PR_HTTP:'403'});
  assert.equal(r.status, 1);
  assert.equal(r.deletes, '');
});
test('non-preview target is rejected', () => {
  const r = run('reap-preview-envs.sh', [], {TARGET_ENVIRONMENT:'production'});
  assert.equal(r.status, 2);
  assert.equal(r.deletes, '');
});
test('dry run cannot delete', () => {
  const r = run('reap-preview-envs.sh', [], {TARGET_ENVIRONMENT:'pr-1',DRY_RUN:'1'});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.deletes, '');
});
test('Railway lookup errors do not masquerade as already deleted', () => {
  const r = run('railway-env.sh', ['delete','pr-1'], {LIST_ERROR:'1'});
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /nothing to delete/);
});
test('Railway must confirm the deletion mutation', () => {
  const r = run('railway-env.sh', ['delete','pr-1'], {DELETE_OK:'0'});
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /deleted environment/);
});
test('an absent preview is idempotent', () => {
  const r = run('railway-env.sh', ['delete','pr-999']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nothing to delete/);
});

test('an absent target needs no WorkOS access', () => {
  const r = run('reap-preview-envs.sh', [], {TARGET_ENVIRONMENT:'pr-999',WORKOS_FAIL:'1'});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.deletes, '');
});
test('scheduled reconciliation keeps its deletion cap', () => {
  const r = run('reap-preview-envs.sh', [], {MAX_DELETIONS:'1'});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.deletes.trim().split('\n').length, 1);
  assert.match(r.stdout, /deferred 2/);
});
