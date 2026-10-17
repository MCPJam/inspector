import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseConfig } from './hosted-harness-chat-canary.mjs';
import { invokeCli, runAsyncCanaries } from './hosted-harness-async-canary.mjs';
import { runUserTesting } from './hosted-harness-user-testing-canary.mjs';
import { mintSession } from '../.github/scripts/canary-session.mjs';

// Both destinations receive credentials (the AuthKit bearer and MCPJAM_API_KEY),
// so each must be exactly staging, not merely https.
const isPinned = (value, expected) => typeof value === 'string' && URL.canParse(value) && new URL(value).href.replace(/\/$/, '') === expected;

export async function runProductCanary(config) {
  if (config.staging !== true || !isPinned(config.webUrl, 'https://staging.mcpjam.com') ||
      !isPinned(config.apiUrl, 'https://staging.mcpjam.com/api/v1') ||
      (process.env.WORKOS_API_BASE && process.env.WORKOS_API_BASE !== 'https://api.workos.com')) throw new Error('pinned_staging_required');
  const tokens = JSON.parse(process.env.HARNESS_PRODUCT_STUDY_TOKENS || '{}');
  const invoke = args => invokeCli(config, args);
  const report = await runAsyncCanaries(config, invoke);
  let bearer;
  if (process.env.ASK_MCPJAM_CANARY_EMAIL && process.env.WORKOS_API_KEY && process.env.WORKOS_CLIENT_ID) {
      bearer = await mintSession({ email: process.env.ASK_MCPJAM_CANARY_EMAIL,
        apiKey: process.env.WORKOS_API_KEY, clientId: process.env.WORKOS_CLIENT_ID });

  }
  report.results.push(...await runUserTesting(config, bearer, tokens, invoke));
  return { ...report, scope: 'hosted-eval-swarm-user-testing', qualification: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report;
  try {
    if (!process.env.HARNESS_PRODUCT_CANARY_CONFIG || !process.env.MCPJAM_API_KEY) throw new Error('configuration_missing');
    report = await runProductCanary(parseConfig(process.env.HARNESS_PRODUCT_CANARY_CONFIG));
  } catch (error) {
    report = { scope: 'hosted-eval-swarm-user-testing', qualification: false, status: 'not_run', reason: error.message === 'pinned_staging_required' ? 'pinned_staging_required' : 'configuration_or_auth_failed' };
  }
  writeFileSync(process.env.HARNESS_PRODUCT_CANARY_REPORT || 'harness-product-canary.json', JSON.stringify(report, null, 2));
  process.exitCode = report.results?.length > 0 && report.results.every(result => result.status === 'passed') ? 0 : 1;
}
