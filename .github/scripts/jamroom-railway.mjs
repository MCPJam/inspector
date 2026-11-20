// Fixed deployment target. The Jamroom relay lives in a different environment
// in this project. Checks run before any privileged Railway mutation.
const PROJECT = 'd22e50d2-c900-42bd-b10a-8bb405cfbd59';
const TEMPLATE = '467139c3-7214-4a17-9f37-c8752fafe663';
const SERVICE = '75f13196-2f07-457f-81d6-c9517cf554d1';
const REPO = 'MCPJam/inspector';
const RAILWAY = 'https://backboard.railway.app/graphql/v2';
const NAME = /^jr-[a-z0-9][a-z0-9-]{1,29}-[0-9a-f]{8}$/;

const FIXED_PROFILE = {
  ENVIRONMENT: 'preview',
  VITE_ENVIRONMENT: 'preview',
  VITE_MCPJAM_HOSTED_MODE: 'true',
  DO_NOT_TRACK: '1',
  MCPJAM_LOCAL_DOORBELL_MS: '3000',
  MCPJAM_GUEST_AUTHORITY: 'backend',
  AUTHKIT_DOMAIN: 'balanced-cactus-76-agents.authkit.app',
  WORKOS_CLIENT_ID: 'client_01M7GY3B5CJCB8VHR0K9MWTWJ2',
  VITE_WORKOS_CLIENT_ID: 'client_01M7GY3B5CJCB8VHR0K9MWTWJ2',
};
const PRIVATE_PROFILE = [
  'INSPECTOR_SERVICE_TOKEN',
  'MCPJAM_GUEST_SESSION_SHARED_SECRET',
  'GUEST_SESSION_HASH_PEPPER',
];

export function previewVariables(input) {
  const allowed = new Set([
    ...Object.keys(FIXED_PROFILE), ...PRIVATE_PROFILE, 'VITE_CONVEX_URL',
    'CONVEX_URL', 'CONVEX_HTTP_URL', 'MCPJAM_FEATURE_FLAGS',
  ]);
  if (!input || Object.keys(input).some((name) => !allowed.has(name))) {
    throw new Error('Jamroom returned unexpected preview variables.');
  }
  const backend = /^https:\/\/([a-z0-9-]+)\.convex\.cloud$/.exec(input.CONVEX_URL);
  if (!backend || input.VITE_CONVEX_URL !== input.CONVEX_URL ||
      input.CONVEX_HTTP_URL !== `https://${backend[1]}.convex.site`) {
    throw new Error('Jamroom returned an invalid preview backend.');
  }
  for (const [key, value] of Object.entries(FIXED_PROFILE)) {
    if (input[key] !== value) throw new Error('Jamroom returned an invalid fixed preview setting.');
  }
  for (const key of PRIVATE_PROFILE) {
    if (typeof input[key] !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(input[key])) {
      throw new Error('Jamroom returned an invalid test credential.');
    }
  }
  let flags;
  try {
    flags = JSON.parse(input.MCPJAM_FEATURE_FLAGS);
  } catch {
    throw new Error('Jamroom returned invalid preview flags.');
  }
  if (!flags || typeof flags !== 'object' || Array.isArray(flags) ||
      Object.values(flags).some((answer) => typeof answer !== 'boolean' && typeof answer !== 'string')) {
    throw new Error('Jamroom returned invalid preview flags.');
  }
  return { ...input };
}

async function readJson(fetcher, url, init = {}) {
  const response = await fetcher(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}.`);
  return response.json();
}

async function verifyCommit(job, githubToken, fetcher) {
  if (!/^[0-9a-f]{40}$/.test(job.inspectorCommit ?? '') ||
      typeof job.inspectorBranch !== 'string' || !/^[A-Za-z0-9._/-]{1,200}$/.test(job.inspectorBranch)) {
    throw new Error('Jamroom returned an invalid Inspector revision.');
  }
  const branch = encodeURIComponent(job.inspectorBranch);
  const headers = { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json' };
  const ref = await readJson(fetcher, `https://api.github.com/repos/${REPO}/branches/${branch}`, { headers });
  if (!/^[0-9a-f]{40}$/.test(ref.commit?.sha ?? '')) throw new Error('Inspector branch has no verified SHA.');
  const result = await readJson(fetcher, `https://api.github.com/repos/${REPO}/compare/${job.inspectorCommit}...${ref.commit.sha}`, { headers });
  if (!['ahead', 'identical'].includes(result.status)) throw new Error('Inspector SHA is not on the requested branch.');
}

async function listEnvironments(call) {
  let after = null;
  const rows = [];
  do {
    const { project } = await call(`query ($id:String!,$after:String) {
      project(id:$id) { name environments(first:100,after:$after) {
        pageInfo { endCursor hasNextPage }
        edges { node { id name deploymentTriggers { edges { node { id } } }
          serviceInstances { edges { node { serviceId source { repo } latestDeployment { id status meta } } } }
        } }
      } }
    }`, { id: PROJECT, after });
    if (project.name !== 'jamroom-preview-test') throw new Error('Unexpected Railway project.');
    rows.push(...project.environments.edges.map(({ node }) => node));
    const page = project.environments.pageInfo;
    if (page.hasNextPage && !page.endCursor) throw new Error('Incomplete Railway environment list.');
    after = page.hasNextPage ? page.endCursor : null;
  } while (after);
  return rows;
}

function inspectorInstance(environment, allowEmpty = false) {
  const services = environment.serviceInstances.edges.map(({ node }) => node);
  if ((!allowEmpty && services.length !== 1) || environment.deploymentTriggers.edges.length ||
      services.some(({ serviceId, source }) => serviceId !== SERVICE || source?.repo !== REPO)) {
    throw new Error('Railway environment is not isolated to the Jamroom Inspector service.');
  }
  return services[0];
}

async function requireEmptySharedVariables(call, environmentId) {
  const { variables } = await call(`query ($p:String!,$e:String!) {
    variables(projectId:$p,environmentId:$e)
  }`, { p: PROJECT, e: environmentId });
  if (!variables || Object.keys(variables).length) {
    throw new Error('The Railway preview environment contains shared variables.');
  }
}

async function getOrigin(call, environmentId) {
  const { domains } = await call(`query ($projectId:String!,$environmentId:String!,$serviceId:String!) {
    domains(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId) {
      serviceDomains { domain } customDomains { domain }
    }
  }`, { projectId: PROJECT, environmentId, serviceId: SERVICE });
  if (domains.customDomains.length || domains.serviceDomains.length > 1) throw new Error('Unexpected preview domain configuration.');
  const [{ domain } = {}] = domains.serviceDomains;
  const hostname = domain ?? (await call(`mutation ($input:ServiceDomainCreateInput!) {
    serviceDomainCreate(input:$input) { domain }
  }`, { input: { environmentId, serviceId: SERVICE } })).serviceDomainCreate.domain;
  if (!/^[a-z0-9-]+\.up\.railway\.app$/.test(hostname)) throw new Error('Unexpected preview domain.');
  return `https://${hostname}`;
}

export async function railwayJob(job, { railwayToken, githubToken, fetcher = fetch, waitDeployment, removeEnvironment }) {
  if (!NAME.test(job.name ?? '') || !['provision', 'delete'].includes(job.operation)) {
    throw new Error('Invalid Jamroom Railway job.');
  }
  const call = async (query, variables) => {
    const payload = await readJson(fetcher, RAILWAY, {
      method: 'POST',
      headers: { Authorization: `Bearer ${railwayToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    // Provider errors can echo secret variable values.
    if (payload.errors?.length || !payload.data) throw new Error('Railway refused the preview operation.');
    return payload.data;
  };
  const environments = await listEnvironments(call);
  const existing = environments.filter(({ name }) => name === job.name);
  if (existing.length > 1) throw new Error('Duplicate Railway preview environments.');
  let [environment] = existing;
  if (environment?.id === TEMPLATE) throw new Error('The preview job targets the Railway template.');

  if (job.operation === 'delete') {
    if (environment) {
      inspectorInstance(environment, true);
      await removeEnvironment(environment.id, PROJECT);
    }
    return {};
  }

  const variables = previewVariables(job.variables);
  await verifyCommit(job, githubToken, fetcher);
  const template = environments.find(({ id }) => id === TEMPLATE);
  if (!template || inspectorInstance(template).latestDeployment) throw new Error('The clean Railway preview template is unavailable.');
  await requireEmptySharedVariables(call, TEMPLATE);
  if (!environment) {
    const { environmentCreate } = await call(`mutation ($input:EnvironmentCreateInput!) {
      environmentCreate(input:$input) { id }
    }`, { input: { projectId: PROJECT, name: job.name, sourceEnvironmentId: TEMPLATE, skipInitialDeploys: true } });
    environment = (await listEnvironments(call)).find(({ id }) => id === environmentCreate.id);
    if (environment?.name !== job.name) throw new Error('Railway did not create the requested preview.');
  }
  const instance = inspectorInstance(environment);
  await requireEmptySharedVariables(call, environment.id);
  const origin = await getOrigin(call, environment.id);
  const previous = instance.latestDeployment;
  if (previous && previous.meta?.commitHash === job.inspectorCommit &&
      !['FAILED', 'CRASHED', 'REMOVED', 'SKIPPED', 'CANCELLED'].includes(previous.status)) {
    await waitDeployment(previous.id, SERVICE, environment.id);
    return { origin };
  }
  if (previous && previous.meta?.commitHash && previous.meta.commitHash !== job.inspectorCommit) {
    throw new Error('The existing Railway deployment belongs to another revision.');
  }
  const configured = await call(`mutation ($input:VariableCollectionUpsertInput!) {
    variableCollectionUpsert(input:$input)
  }`, { input: {
    projectId: PROJECT, environmentId: environment.id, serviceId: SERVICE, skipDeploys: true, replace: true,
    variables: {
      ...variables, ALLOWED_ORIGINS: origin, WEB_ALLOWED_ORIGINS: origin,
      MCPJAM_ALLOWED_HOSTS: new URL(origin).hostname,
    },
  } });
  if (!configured.variableCollectionUpsert) throw new Error('Railway did not save preview variables.');
  const deployed = await call(`mutation ($environmentId:String!,$serviceId:String!,$commitSha:String!) {
    serviceInstanceDeployV2(environmentId:$environmentId,serviceId:$serviceId,commitSha:$commitSha)
  }`, { environmentId: environment.id, serviceId: SERVICE, commitSha: job.inspectorCommit });
  if (!deployed.serviceInstanceDeployV2) throw new Error('Railway did not start the pinned build.');
  await waitDeployment(deployed.serviceInstanceDeployV2, SERVICE, environment.id);
  return { origin };
}
