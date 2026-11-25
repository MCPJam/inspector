import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Resolve once so the run and every gate use the same published CLI. */
export async function resolveCliVersion(selector, run = execute) {
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(selector)) return selector;
  if (!/^[1-9]\d*$/.test(selector))
    throw new Error("Unsupported CLI selector.");
  const { stdout } = await run(
    "npm",
    ["view", `@mcpjam/cli@${selector}`, "version", "--json", "--prefer-online"],
    { timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  const payload = JSON.parse(stdout);
  const versions = (Array.isArray(payload) ? payload : [payload]).filter(
    (value) =>
      typeof value === "string" &&
      /^\d+\.\d+\.\d+$/.test(value) &&
      value.split(".")[0] === selector,
  );
  versions.sort((a, b) => {
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    return left[1] - right[1] || left[2] - right[2];
  });
  if (!versions.length) throw new Error("No stable CLI release found.");
  return versions.at(-1);
}
