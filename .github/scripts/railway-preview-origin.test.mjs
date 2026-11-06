import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePreviewOrigin } from './railway-preview-origin.mjs';

const FRONTEND = 'mcp-inspector-pr-7214.up.railway.app';
const scope = { projectId: 'project', environment: 'pr-7214', serviceId: 'inspector', token: 'private-token' };

function fixture(overrides = {}) {
  return {
    environments: [{ node: { id: 'env-7214', name: 'pr-7214' } }],
    domains: { serviceDomains: [{ domain: FRONTEND }], customDomains: [{ domain: '*.sandbox-pr-7214.mcpjam.com' }] },
    variables: {
      RAILWAY_PUBLIC_DOMAIN: '*.sandbox-pr-7214.mcpjam.com',
      MCPJAM_INSPECTOR_FRONTEND_URL: `https://${FRONTEND}`,
      PRIVATE_VALUE: 'must-not-be-printed',
    },
    ...overrides,
  };
}

async function resolve(data = fixture(), options = {}) {
  const requests = [];
  const fetchImpl = async (endpoint, init) => {
    assert.equal(endpoint, 'https://backboard.railway.app/graphql/v2');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    const request = JSON.parse(init.body);
    requests.push(request);
    assert.match(request.query, /^query /);
    if (request.query.includes('PreviewEnvironments')) {
      assert.deepEqual(request.variables, { id: scope.projectId });
      return Response.json({ data: { project: { environments: { edges: data.environments } } } });
    }
    assert.deepEqual(request.variables, { projectId: scope.projectId, environmentId: 'env-7214', serviceId: scope.serviceId });
    if (request.query.includes('query Domains')) return Response.json({ data: { domains: data.domains } });
    return Response.json({ data: { variables: data.variables } });
  };
  const origin = await resolvePreviewOrigin({ ...scope, fetchImpl, ...options });
  return { origin, requests };
}

test('wildcard public aliases never replace the explicit owned canonical origin', async () => {
  const { origin, requests } = await resolve();
  assert.equal(origin, `https://${FRONTEND}`);
  assert.equal(requests.length, 3);
});

test('a concrete custom canonical domain is accepted only when attached to this service', async () => {
  const data = fixture();
  data.domains.customDomains.push({ domain: 'preview.example.com' });
  data.variables.MCPJAM_INSPECTOR_FRONTEND_URL = 'https://preview.example.com:443/';
  assert.equal((await resolve(data)).origin, 'https://preview.example.com');
});

test('normal previews without an explicit URL use their single generated provider domain', async () => {
  const { origin } = await resolve(fixture({ variables: { RAILWAY_PUBLIC_DOMAIN: '*.sandbox.example.com' } }));
  assert.equal(origin, `https://${FRONTEND}`);
});

test('environment UUID lookup remains scoped to the selected project', async () => {
  assert.equal((await resolve(fixture(), { environment: 'env-7214' })).origin, `https://${FRONTEND}`);
});

test('an inherited staging URL is refused even when a valid fallback exists', async () => {
  const data = fixture();
  data.variables.MCPJAM_INSPECTOR_FRONTEND_URL = 'https://staging.mcpjam.com';
  await assert.rejects(resolve(data), /not attached to the selected Railway service/);
});

for (const value of [
  'https://*.sandbox.example.com', 'https://%2a.sandbox.example.com',
  'http://preview.example.com', '//preview.example.com',
  'https://user:password@preview.example.com', 'https://preview.example.com/path',
  'https://preview.example.com/../', 'https://preview.example.com?next=private',
  'https://preview.example.com#private', 'https://preview.example.com:8443',
  'https://preview.example.com\\private', 'https://preview.example.com\nurl=https://attacker.example.com',
  'https://preview.example.com\n', 'https://preview.example.com\r', 'https://preview.example.com\t',
  'https://preview.example.com/%0a', 'https://preview..example.com',
  'https://-preview.example.com', ' https://preview.example.com', null, {},
]) {
  test(`malformed explicit origin is refused (${JSON.stringify(value)})`, async () => {
    const data = fixture();
    data.variables.MCPJAM_INSPECTOR_FRONTEND_URL = value;
    await assert.rejects(resolve(data), /concrete HTTPS origin|concrete DNS hostname/);
  });
}

for (const serviceDomains of [[], [{ domain: '*.up.railway.app' }],
  [{ domain: 'other.example.com' }], [{ domain: FRONTEND }, { domain: 'second.up.railway.app' }]]) {
  test(`missing or ambiguous generated domain is refused (${JSON.stringify(serviceDomains)})`, async () => {
    await assert.rejects(resolve(fixture({ variables: {}, domains: { serviceDomains, customDomains: [] } })), /no unambiguous generated preview domain/);
  });
}

test('missing and duplicate environment matches fail before service reads', async () => {
  for (const environments of [[], [{ node: { id: 'wrong', name: 'pr-2' } }],
    [{ node: { id: 'env-7214', name: 'pr-7214' } }, { node: { id: 'other', name: 'pr-7214' } }]]) {
    await assert.rejects(resolve(fixture({ environments })), /exactly one environment/);
  }
});

test('a wrong-service canonical domain cannot borrow another service domain', async () => {
  await assert.rejects(resolve(fixture({ domains: {
    serviceDomains: [{ domain: 'other-service.up.railway.app' }], customDomains: [],
  } })), /not attached/);
});

test('malformed provider domain and variable metadata fail closed', async () => {
  for (const domains of [null, {}, { serviceDomains: 'wrong', customDomains: [] },
    { serviceDomains: [{ domain: 42 }], customDomains: [] }]) {
    await assert.rejects(resolve(fixture({ domains })), /invalid preview domain metadata/);
  }
  for (const variables of [null, [], 'private']) {
    await assert.rejects(resolve(fixture({ variables })), /invalid preview variable metadata/);
  }
});

test('provider failures never disclose raw errors, variables, or token', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('private-token private-provider-details'); },
    async () => Response.json({ errors: [{ message: 'private-provider-details' }] }),
    async () => new Response('private-provider-details', { status: 500 }),
  ]) {
    await assert.rejects(resolvePreviewOrigin({ ...scope, fetchImpl }), (error) => {
      assert.doesNotMatch(error.message, /private/);
      assert.match(error.message, /metadata/);
      return true;
    });
  }
});

test('the executable emits exactly one validated origin and emits none on refusal', () => {
  for (const bad of [false, true]) {
    const data = fixture();
    if (bad) data.variables.MCPJAM_INSPECTOR_FRONTEND_URL += '\nurl=https://attacker.example.com';
    const mock = `const data=${JSON.stringify(data)};globalThis.fetch=async(_,init)=>{const q=JSON.parse(init.body).query;return Response.json({data:q.includes('PreviewEnvironments')?{project:{environments:{edges:data.environments}}}:q.includes('query Domains')?{domains:data.domains}:{variables:data.variables}})};`;
    const result = spawnSync(process.execPath, [
      '--import', `data:text/javascript,${encodeURIComponent(mock)}`,
      fileURLToPath(new URL('./railway-preview-origin.mjs', import.meta.url)), '-e', scope.environment, '-s', scope.serviceId,
    ], { encoding: 'utf8', env: { ...process.env, RAILWAY_PROJECT_ID: scope.projectId, RAILWAY_API_TOKEN: scope.token } });
    assert.equal(result.status, bad ? 1 : 0, result.stderr);
    assert.equal(result.stdout, bad ? '' : `https://${FRONTEND}\n`);
    assert.doesNotMatch(result.stderr, /private-token|must-not-be-printed|attacker/);
  }
});

test('all preview jobs resolve a concrete service origin before registering it', () => {
  const workflow = readFileSync(new URL('../workflows/pr-preview.yml', import.meta.url), 'utf8');
  assert.equal((workflow.match(/node \.github\/scripts\/railway-preview-origin\.mjs/g) || []).length, 3);
  assert.doesNotMatch(workflow, /printenv RAILWAY_PUBLIC_DOMAIN/);
  assert.doesNotMatch(workflow, /id: preview_domain\n\s+continue-on-error: true/);
  const checks = readFileSync(new URL('../workflows/preview-cleanup-checks.yml', import.meta.url), 'utf8');
  assert.match(checks, /node --test .*railway-preview-origin\.test\.mjs/);
  assert.equal((checks.match(/- \.github\/scripts\/railway-preview-origin\.mjs/g) || []).length, 2);
});
