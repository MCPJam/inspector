import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const workflow = readFileSync(new URL("../workflows/pr-preview.yml", import.meta.url), "utf8");
test("all preview deployment paths configure identity and publish only a reachable protected URL", () => {
  for (const name of ["upsert-preview", "upsert-backend-pr-preview", "sync-backend-preview"]) {
    const job = workflow.split(`  ${name}:`)[1].split(/\n  [a-z][a-z-]+:/)[0];
    assert.match(job, /PREVIEW_EDGE_SECRET: \$\{\{ secrets.PREVIEW_EDGE_SECRET \}\}/);
    assert.ok(job.includes('PREVIEW_EDGE_SECRET="$PREVIEW_EDGE_SECRET"'));
    assert.ok(job.includes('WORKOS_CLEANUP_STRICT=1 bash .github/scripts/workos-cleanup.sh'));
    assert.ok(!job.includes('workos config redirect add "${{ steps.preview_domain.outputs.url }}'));
    assert.ok(job.includes('workos config redirect add "$PUBLIC_PREVIEW_ORIGIN/callback"'));
    assert.ok(job.indexOf("id: protected_preview") > job.indexOf("id: preview_domain"));
    assert.match(job, /id: protected_preview\n        if: steps.preview_domain.outputs.url != ''/);
    for (const line of job.split("\n").filter(line => line.includes("PREVIEW_URL:"))) {
      assert.match(line, /protected_preview.outcome == 'success'/);
    }
  }
});
for (const [label, body, status] of [["healthy", '{"status":"ok"}', 0], ["router 404", "not found", 1], ["SPA instead of health", "<html>app</html>", 1]]) {
  test(`protected routing check: ${label}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "protected-preview-"));
    try {
      writeFileSync(join(dir, "curl"), `#!/bin/sh\nprintf '%s' '${body}'\n`, { mode: 0o755 });
      writeFileSync(join(dir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const result = spawnSync("bash", [new URL("check-protected-preview.sh", import.meta.url).pathname, "https://pr-5826.mcpjam.dev"], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" });
      assert.equal(result.status, status, result.stderr);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
