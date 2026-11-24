import assert from 'node:assert/strict';
import test from 'node:test';
import { railwayJob } from './jamroom-railway.mjs';

const PROJECT = 'd22e50d2-c900-42bd-b10a-8bb405cfbd59';
const TEMPLATE = '467139c3-7214-4a17-9f37-c8752fafe663';
const SERVICE = '75f13196-2f07-457f-81d6-c9517cf554d1';
const INSPECTOR = 'a'.repeat(40);
const NAME = 'jr-preview-12345678';
const job = {
  name: NAME,
  operation: 'provision',
  inspectorCommit: INSPECTOR,
  inspectorBranch: 'feature/demo',
  variables: {
    ENVIRONMENT: 'preview',
    VITE_ENVIRONMENT: 'preview',
    VITE_MCPJAM_HOSTED_MODE: 'true',
    DO_NOT_TRACK: '1',
    MCPJAM_LOCAL_DOORBELL_MS: '3000',
    MCPJAM_GUEST_AUTHORITY: 'backend',
    AUTHKIT_DOMAIN: 'balanced-cactus-76-agents.authkit.app',
    WORKOS_CLIENT_ID: 'client_01M7GY3B5CJCB8VHR0K9MWTWJ2',
    VITE_WORKOS_CLIENT_ID: 'client_01M7GY3B5CJCB8VHR0K9MWTWJ2',
    INSPECTOR_SERVICE_TOKEN: 'fixture_service_token',
    MCPJAM_GUEST_SESSION_SHARED_SECRET: 'fixture_guest_secret',
    GUEST_SESSION_HASH_PEPPER: 'fixture_guest_pepper',
    CONVEX_URL: 'https://dev-preview.convex.cloud',
    VITE_CONVEX_URL: 'https://dev-preview.convex.cloud',
    CONVEX_HTTP_URL: 'https://dev-preview.convex.site',
    MCPJAM_FEATURE_FLAGS: '{"flag":true}',
  },
};

function environment(id, name, serviceId = SERVICE, latestDeployment = null) {
  return {
    id,
    name,
    deploymentTriggers: { edges: [] },
    serviceInstances: {
      edges: [{ node: { serviceId, source: { repo: 'MCPJam/inspector' }, latestDeployment } }],
    },
  };
}

function fixture({
  template = environment(TEMPLATE, 'clean'),
  existing,
  status = 'ahead',
  sharedVariables = {},
} = {}) {
  const mutations = [];
  const actions = [];
  const environments = [template, ...(existing ? [existing] : [])];
  const fetcher = async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'api.github.com') {
      assert.match(url.pathname, /^\/repos\/MCPJam\/inspector\//);
      if (url.pathname.includes('/branches/')) {
        return Response.json({ commit: { sha: 'b'.repeat(40) } });
      }
      assert.ok(url.pathname.endsWith(`/${INSPECTOR}...${'b'.repeat(40)}`));
      return Response.json({ status });
    }
    assert.equal(url.hostname, 'backboard.railway.app');
    const { query, variables } = JSON.parse(options.body);
    if (query.includes('query') && query.includes('environments(')) {
      assert.equal(variables.id, PROJECT);
      return Response.json({ data: { project: {
        name: 'jamroom-preview-test',
        environments: { pageInfo: { hasNextPage: false }, edges: environments.map((node) => ({ node })) },
      } } });
    }
    if (query.includes('variables(projectId:')) {
      return Response.json({ data: { variables: sharedVariables } });
    }
    if (query.includes('domains(')) return Response.json({ data: {
      domains: { serviceDomains: [{ domain: 'preview.up.railway.app' }], customDomains: [] },
    } });
    mutations.push(variables);
    if (query.includes('environmentCreate')) {
      environments.push(environment('env-id', NAME));
      return Response.json({ data: { environmentCreate: { id: 'env-id' } } });
    }
    if (query.includes('variableCollectionUpsert')) {
      return Response.json({ data: { variableCollectionUpsert: true } });
    }
    if (query.includes('serviceInstanceDeployV2')) {
      return Response.json({ data: { serviceInstanceDeployV2: 'deploy-id' } });
    }
    throw new Error('Unexpected request');
  };
  const deps = {
    fetcher,
    railwayToken: 'fixture-token',
    githubToken: 'fixture-gh-token',
    waitDeployment: async (...args) => { actions.push(['wait', ...args]); },
    removeEnvironment: async (...args) => { actions.push(['remove', ...args]); },
  };
  return { deps, mutations, actions };
}

test('clones only the clean template and deploys the verified SHA with a test profile', async () => {
  const { deps, mutations, actions } = fixture();
  assert.deepEqual(await railwayJob({ ...job, projectId: 'ignored-project' }, deps), {
    origin: 'https://preview.up.railway.app',
  });
  assert.deepEqual(mutations[0].input, {
    projectId: PROJECT, name: NAME, sourceEnvironmentId: TEMPLATE, skipInitialDeploys: true,
  });
  assert.equal(mutations[1].input.variables.ALLOWED_ORIGINS, 'https://preview.up.railway.app');
  assert.equal(mutations[1].input.skipDeploys, true);
  assert.equal(mutations[1].input.replace, true);
  assert.deepEqual(mutations[2], { environmentId: 'env-id', serviceId: SERVICE, commitSha: INSPECTOR });
  assert.deepEqual(actions, [['wait', 'deploy-id', SERVICE, 'env-id']]);
});

test('refuses a renamed relay or a template with extra services before writing', async () => {
  const relay = environment('relay-env', NAME, 'relay-service');
  const unsafe = fixture({ existing: relay });
  await assert.rejects(railwayJob({ name: NAME, operation: 'delete' }, unsafe.deps), /not isolated/);
  assert.deepEqual(unsafe.actions, []);
  const copy = fixture({ template: environment(TEMPLATE, 'clean', 'relay-service') });
  await assert.rejects(railwayJob(job, copy.deps), /not isolated/);
  assert.deepEqual(copy.mutations, []);
});

test('refuses a template with shared variables before copying it', async () => {
  const { deps, mutations } = fixture({ sharedVariables: { TEST_SECRET: 'fixture' } });
  await assert.rejects(railwayJob(job, deps), /contains shared variables/);
  assert.deepEqual(mutations, []);
});

test('refuses unverified commits and unexpected variables before writing', async () => {
  const state = fixture({ status: 'diverged' });
  await assert.rejects(railwayJob(job, state.deps), /not on the requested branch/);
  await assert.rejects(railwayJob({
    ...job, variables: { ...job.variables, WORKOS_API_KEY: 'fixture' },
  }, state.deps), /unexpected preview variables/);
  assert.deepEqual(state.mutations, []);
});

test('resumes a pinned deployment and deletes only the validated preview', async () => {
  const existing = environment('env-id', NAME, SERVICE, {
    id: 'existing-deploy', status: 'SUCCESS', meta: { commitHash: INSPECTOR },
  });
  const { deps, actions, mutations } = fixture({ existing });
  await railwayJob(job, deps);
  await railwayJob({ name: NAME, operation: 'delete' }, deps);
  assert.deepEqual(actions, [
    ['wait', 'existing-deploy', SERVICE, 'env-id'],
    ['remove', 'env-id', PROJECT],
  ]);
  assert.deepEqual(mutations, []);
});

test('refuses a production-shaped name before reading Railway', async () => {
  await assert.rejects(railwayJob({ name: 'production', operation: 'delete' }, {
    fetcher: () => assert.fail('no provider call expected'),
  }), /Invalid Jamroom Railway job/);
});
