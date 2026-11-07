import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Generate before worker imports cache the shim's content and revision. */
export default function setup() {
  execFileSync(process.execPath, [
    fileURLToPath(new URL("../../scripts/bundle-plugin-shim.mjs", import.meta.url)),
  ], { stdio: "pipe" });
}
