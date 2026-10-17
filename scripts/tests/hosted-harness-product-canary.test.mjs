import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProductCanary } from '../hosted-harness-product-canary.mjs';

test('rejects unpinned destinations before any paid run or AuthKit mint', async () => {
  for (const webUrl of ['https://attacker.test/', 'https://staging.mcpjam.com.attacker.test/', 'https://user:pass@staging.mcpjam.com/']) {
    await assert.rejects(runProductCanary({ staging: true, webUrl }), /pinned_staging_required/);
  }
});
test('not_run retains its report and exits nonzero', () => {
  const directory = mkdtempSync(join(tmpdir(), 'canary-not-run-'));
  try {
    const file = join(directory, 'report.json');
    const result = spawnSync(process.execPath, ['scripts/hosted-harness-product-canary.mjs'], {
      env: { ...process.env, MCPJAM_API_KEY: '', HARNESS_PRODUCT_CANARY_CONFIG: '', HARNESS_PRODUCT_CANARY_REPORT: file },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'not_run');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
