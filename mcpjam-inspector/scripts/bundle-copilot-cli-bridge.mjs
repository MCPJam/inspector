import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../server/utils/harness/copilot-cli/", import.meta.url);
const bundle = await build({
  absWorkingDir: fileURLToPath(new URL("../", import.meta.url)),
  entryPoints: [fileURLToPath(new URL("bridge/index.ts", root))],
  platform: "node",
  format: "esm",
  target: "node20",
  bundle: true,
  // Keep recipe bytes stable when a worktree shares dependency directories.
  preserveSymlinks: true,
  write: false,
  external: ["ws", "@github/copilot-sdk"],
});
const files = { "bridge.mjs": bundle.outputFiles[0].text };
for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
  files[name] = await readFile(new URL("bridge/" + name, root), "utf8");
}
await mkdir(new URL("generated/", root), { recursive: true });
await writeFile(
  new URL("generated/bootstrap.ts", root),
  "export const bootstrapFiles = " + JSON.stringify(files) + ";\n",
);
