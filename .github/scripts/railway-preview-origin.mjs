#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const ENDPOINT = 'https://backboard.railway.app/graphql/v2';
const ENVIRONMENTS = `query PreviewEnvironments($id: String!) {
  project(id: $id) { environments { edges { node { id name } } } }
}`;
const DOMAINS = `query Domains($environmentId: String!, $projectId: String!, $serviceId: String!) {
  domains(environmentId: $environmentId, projectId: $projectId, serviceId: $serviceId) {
    serviceDomains { domain }
    customDomains { domain }
  }
}`;
const VARIABLES = `query PreviewVariables($environmentId: String!, $projectId: String!, $serviceId: String!) {
  variables(environmentId: $environmentId, projectId: $projectId, serviceId: $serviceId)
}`;

function concreteDomain(value) {
  if (typeof value !== 'string' || value.length > 253) return false;
  return value.split('.').length > 1 && value.split('.').every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function explicitOrigin(value) {
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9.-]+(?::443)?\/?$/i.test(value)) {
    throw new Error('Preview frontend URL must be a concrete HTTPS origin without credentials, path, query, or fragment.');
  }
  const url = new URL(value);
  if (!concreteDomain(url.hostname)) {
    throw new Error('Preview frontend URL must use a concrete DNS hostname.');
  }
  return url.origin;
}

function domainList(value) {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item.domain !== 'string')) {
    throw new Error('Railway returned invalid preview domain metadata.');
  }
  return [...new Set(value.map((item) => item.domain.toLowerCase()))];
}

export async function resolvePreviewOrigin({ projectId, environment, serviceId, token, fetchImpl = fetch, wait = delay }) {
  if (![projectId, environment, serviceId, token].every((value) => typeof value === 'string' && value.trim())) {
    throw new Error('Preview origin resolution requires the Railway project, environment, service, and token.');
  }
  async function query(queryText, variables) {
    for (let attempt = 0; attempt < 5; attempt++) {
      let response;
      try {
        response = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: queryText, variables }),
          signal: AbortSignal.timeout(30_000),
          redirect: 'error',
        });
      } catch {
        // Only read queries are retried; provider details may contain secrets.
        if (attempt === 4) throw new Error('Could not read Railway preview origin metadata.');
      }
      if (response?.ok) {
        let result;
        try { result = await response.json(); }
        catch { throw new Error('Railway returned invalid preview origin metadata.'); }
        if (!result || result.errors || !result.data) {
          throw new Error('Railway refused the preview origin metadata query.');
        }
        return result.data;
      }
      if (response && response.status !== 429 && response.status < 500) {
        throw new Error('Railway refused the preview origin metadata query.');
      }
      if (attempt === 4) throw new Error('Railway refused the preview origin metadata query.');
      await wait(1000 * 2 ** attempt);
    }
  }

  const inventory = await query(ENVIRONMENTS, { id: projectId });
  const edges = inventory.project?.environments?.edges;
  if (!Array.isArray(edges)) throw new Error('Railway returned invalid preview environment metadata.');
  const matches = edges.map((edge) => edge?.node)
    .filter((node) => node && (node.id === environment || node.name === environment));
  if (matches.length !== 1 || typeof matches[0].id !== 'string' || !matches[0].id) {
    throw new Error('Preview environment must match exactly one environment in the selected Railway project.');
  }
  const scope = { projectId, environmentId: matches[0].id, serviceId };
  const { domains } = await query(DOMAINS, scope);
  const generated = domainList(domains?.serviceDomains);
  const custom = domainList(domains?.customDomains);
  const { variables } = await query(VARIABLES, scope);
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
    throw new Error('Railway returned invalid preview variable metadata.');
  }

  const explicit = variables.MCPJAM_INSPECTOR_FRONTEND_URL;
  if (Object.hasOwn(variables, 'MCPJAM_INSPECTOR_FRONTEND_URL') && explicit !== '') {
    const origin = explicitOrigin(explicit);
    const hostname = new URL(origin).hostname;
    if (![...generated, ...custom].some((domain) => concreteDomain(domain) && domain === hostname)) {
      throw new Error('Preview frontend URL is not attached to the selected Railway service and environment.');
    }
    return origin;
  }

  if (generated.length !== 1 || !concreteDomain(generated[0]) || !generated[0].endsWith('.up.railway.app')) {
    throw new Error('Set a concrete frontend URL attached to this service; Railway has no unambiguous generated preview domain.');
  }
  return `https://${generated[0]}`;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  let environment;
  let serviceId;
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] === '-e' && !environment) environment = args[index + 1];
    else if (args[index] === '-s' && !serviceId) serviceId = args[index + 1];
    else throw new Error('Usage: railway-preview-origin.mjs -e ENVIRONMENT -s SERVICE_ID');
  }
  return resolvePreviewOrigin({ projectId: env.RAILWAY_PROJECT_ID, environment, serviceId, token: env.RAILWAY_API_TOKEN });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((origin) => console.log(origin)).catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
