// Re-run the project's existing arithmetic regression through the public API.
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');
const configured = process.env.MCPJAM_API_URL;
if (!configured || !process.env.MCPJAM_API_KEY) throw Error('Set MCPJAM_API_URL and MCPJAM_API_KEY');
const base = configured.replace(/\/$/, '').replace(/\/api\/v1$/, '') + '/api/v1';
const prefix = '/projects/project_fixture';
async function api(path, body) {
  const response = await fetch(base + prefix + path, {
    method: body ? 'POST' : 'GET',
    headers: {Authorization: `Bearer ${process.env.MCPJAM_API_KEY}`, 'Content-Type':'application/json'},
    ...(body ? {body: JSON.stringify(body)} : {}),
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json();
  if (!response.ok || result.error || result.code) throw Error(JSON.stringify(result));
  return result;
}
(async () => {
  const launch = await api('/eval-runs', {suiteId:'suite_fixture',serverIds:['server_fixture'],idempotencyKey:randomUUID()});
  fs.writeFileSync('rerun-launch.json',JSON.stringify(launch,null,2));
  for(let i=0;i<20;i++) {
    const status=await api(`/eval-runs/${encodeURIComponent(launch.runId)}`);
    if(['completed','failed','cancelled','timed_out'].includes(status.status)) {
      fs.writeFileSync('rerun-status.json',JSON.stringify(status,null,2));
      const evidence=await api(`/eval-runs/${encodeURIComponent(launch.runId)}/iterations`);
      fs.writeFileSync('rerun-iterations.json',JSON.stringify(evidence,null,2));
      console.log(JSON.stringify(status,null,2));
      process.exitCode=status.status==='completed' && status.result==='passed' ? 0 : 1;
      return;
    }
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw Error('No terminal verdict within polling budget');
})().catch(error=>{console.error(error.message);process.exitCode=2;});
