import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
it("OpenAPI swarm reporting components exactly match the canonical nested schemas", () => {
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "sdk/scripts/generate-swarm-report-schema.ts",
      "--check",
    ],
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), stdio: "pipe" }
  );
});
