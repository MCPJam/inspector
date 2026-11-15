import fs from 'node:fs/promises';
const base = process.env.MCPJAM_API_URL;
const key = process.env.MCPJAM_API_KEY;
if (!base || !key) throw new Error('Set MCPJAM_API_URL and MCPJAM_API_KEY');
const project = 'project_fixture';
async function api(path, body) {
  const response = await fetch(`${base.replace(/\/$/, '')}/projects/${project}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json'},
    ...(body ? {body: JSON.stringify(body)} : {})
  });
  const data = await response.json();
  if (!response.ok || data.code) throw new Error(JSON.stringify(data));
  return data;
}
async function save(name, value) {
  await fs.writeFile(name, JSON.stringify(value, null, 2) + '\n');
}
if (process.argv.includes('--create')) {
  await save('suite-created.json', await api('/eval-suites', JSON.parse(await fs.readFile('suite.json', 'utf8'))));
}
const {suiteId} = JSON.parse(await fs.readFile('suite-created.json', 'utf8'));
if (!suiteId) throw new Error('Missing saved suiteId; use --create');
await save('run-request.json', {suiteId});
const run = await api('/eval-runs', {suiteId});
await save('run-created.json', run);
let status;
for (let attempt = 0; attempt < 30; attempt++) {
  status = await api(`/eval-runs/${run.runId}`);
  await save('run-status.json', status);
  if (['completed', 'failed', 'cancelled', 'timed_out'].includes(status.status)) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
await save('iterations.json', await api(`/eval-runs/${run.runId}/iterations`));
console.log(JSON.stringify({runId: run.runId, suiteId, ...status}, null, 2));
if (status.status !== 'completed' || status.result !== 'passed') process.exitCode = 1;
