import { execFileSync } from 'node:child_process';
import { railwayJob } from './jamroom-railway.mjs';

const BROKER = 'https://jamroom.mcpjam.com/internal/preview-runner';
const AUDIENCE = 'mcpjam:jamroom-preview-runner';
const { ACTIONS_ID_TOKEN_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN, RAILWAY_API_TOKEN, GH_TOKEN } = process.env;

async function request(path, payload) {
  const endpoint = new URL(ACTIONS_ID_TOKEN_REQUEST_URL);
  endpoint.searchParams.set('audience', AUDIENCE);
  const token = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!token.ok) throw new Error(`GitHub could not issue a runner token (HTTP ${token.status}).`);
  const { value } = await token.json();
  return fetch(`${BROKER}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${value}`, 'Content-Type': 'application/json' },
    body: payload && JSON.stringify(payload),
    redirect: 'error', signal: AbortSignal.timeout(25_000),
  });
}

const runScript = (script, args, env) => {
  execFileSync(`.github/scripts/${script}`, args, {
    env: { ...process.env, ...env },
    timeout: 17 * 60_000,
    stdio: 'ignore',
  });
};

async function main() {
  if (!RAILWAY_API_TOKEN || !GH_TOKEN) throw new Error('Missing GitHub or Railway credentials.');
  const claim = await request('claim');
  if (claim.status === 204) return;
  if (!claim.ok) throw new Error(`Jamroom refused the request (HTTP ${claim.status}).`);
  const job = await claim.json();
  let outcome = { ok: false };
  try {
    const fields = await railwayJob(job, {
      railwayToken: RAILWAY_API_TOKEN,
      githubToken: GH_TOKEN,
      waitDeployment: (deployment, service, environment) =>
        runScript('railway-wait-deploy.sh', ['--deployment', deployment, '-s', service, '-e', environment]),
      removeEnvironment: (environment, project) =>
        runScript('railway-env.sh', ['delete', environment], { RAILWAY_PROJECT_ID: project }),
    });
    outcome = { ok: true, ...fields };
  } catch {
    // An exception can contain an upstream response or inherited credentials.
    // Report only a fixed message and an authenticated queue failure.
    process.exitCode = 1;
    console.error('The Jamroom Railway job failed. Its lease will be retried.');
  }
  const result = await request('result', { name: job.name, lease: job.lease, outcome });
  if (!result.ok) throw new Error(`Jamroom rejected the job result (HTTP ${result.status}).`);
}
main().catch(() => {
  console.error('Could not complete the Jamroom runner request.');
  process.exitCode = 1;
});
