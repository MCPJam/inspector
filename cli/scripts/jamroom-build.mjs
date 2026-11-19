import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = fileURLToPath(new URL("../../", import.meta.url));
for (const name of ["sdk", "cli"]) {
  const link = join(checkout, "node_modules", "@mcpjam", name);
  if (realpathSync(link) !== realpathSync(join(checkout, name))) {
    throw new Error("Install dependencies in the selected Inspector worktree before building its CLI.");
  }
}

const require = createRequire(join(checkout, "cli/package.json"));
const sdk = realpathSync(require.resolve("@mcpjam/sdk/platform"));
if (!sdk.startsWith(realpathSync(join(checkout, "sdk")) + "/")) {
  throw new Error("The CLI resolves an SDK outside the selected worktree.");
}
// The Inspector launcher prepared the SDK before this build starts.
execFileSync("npm", ["run", "build", "-w", "@mcpjam/cli"], {
  cwd: checkout,
  stdio: ["ignore", 2, 2],
});
process.stdout.write(realpathSync(join(checkout, "cli/dist/index.js")) + "\n");
