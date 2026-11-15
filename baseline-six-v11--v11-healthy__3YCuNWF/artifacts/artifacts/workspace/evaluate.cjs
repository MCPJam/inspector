const fs = require('node:fs');
const base = process.env.MCPJAM_API_URL;
const key = process.env.MCPJAM_API_KEY;
if (!base || !key) throw new Error('Set MCPJAM_API_URL and MCPJAM_API_KEY');
const project = 'project_fixture';
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
async function api(path, body) {
  const response = await fetch(`${base}/projects/${project}/${path}`, {
    method: body ? 'POST' : 'GET', headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok || result.code) throw new Error(JSON.stringify(result));
  return result;
}
(async () => {
  fs.mkdirSync('reports', { recursive: true });
  const receiptPath = 'reports/minimal-suite.json';
  const receipt = fs.existsSync(receiptPath)
    ? JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
    : await api('eval-suites', JSON.parse(fs.readFileSync('minimal-suite.json', 'utf8')));
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  const launch = await api('eval-runs', { suiteId: receipt.suiteId });
  fs.writeFileSync('reports/repeat-launch.json', JSON.stringify(launch, null, 2));
  const deadline = Date.now() + 30000;
  let status;
  do {
    status = await api(`eval-runs/${launch.runId}`);
    if (['completed', 'failed', 'cancelled', 'timed_out'].includes(status.status)) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  const iterations = await api(`eval-runs/${launch.runId}/iterations`);
  const calls = (iterations.items || []).flatMap(i => i.actualToolCalls || []);
  const checks = {
    completed: status.status === 'completed',
    platformPassed: status.result === 'passed',
    evidencePresent: iterations.items?.length > 0,
    allTrialsCorrect: iterations.items?.length > 0 && iterations.items.every(i =>
      i.status === 'completed' && i.result === 'passed' && !i.error &&
      i.actualToolCalls?.length === 1 && i.actualToolCalls.every(c =>
        c.toolName === 'add' && c.arguments.a === 2 && c.arguments.b === 3 &&
        c.result?.isError === false && c.result?.structuredContent?.sum === 5)),
  };
  const report = { suiteId: receipt.suiteId, runId: launch.runId,
    scope: 'Deterministic MCP tool execution; no model selection evaluated',
    expected: {toolName: 'add', arguments: {a: 2, b: 3}, sum: 5},
    checks, passed: Object.values(checks).every(Boolean), status, iterations };
  fs.writeFileSync('reports/repeat-evaluation.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({runId: report.runId, passed: report.passed, checks, trials: iterations.items?.length}, null, 2));
  if (!report.passed) process.exitCode = 1;
})().catch(error => { console.error(error.message); process.exitCode = 1; });
