import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Changesets publishes concurrently; publish the new dependency before its SDK consumers. */
export function publishEvaluatorsFirst(
  version,
  run = (args) => spawnSync("npm", args, { encoding: "utf8" }),
  sleep = (ms) =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  { attempts = 20, intervalMs = 3000 } = {}
) {
  const name = "@mcpjam/evaluators";
  const lookup = () => run(["view", `${name}@${version}`, "version", "--json"]);
  const first = lookup();
  if (first.status === 0) {
    if (JSON.parse(first.stdout) !== version)
      throw new Error("Unexpected evaluator registry version");
    return "already-published";
  }
  let code;
  try {
    code = JSON.parse(first.stdout).error?.code;
  } catch {
    /* Fail closed below. */
  }
  if (code !== "E404")
    throw new Error(
      "Could not verify evaluator registry state; refusing dependent publication"
    );
  const result = run(["publish", "--workspace", name, "--access", "public"]);
  if (result.status !== 0)
    throw new Error(
      "Evaluator publication failed; dependent publication must stop"
    );
  // A brand-new package name is not readable the instant `npm publish`
  // returns. `changeset publish` runs its own `npm info` next, and a 404 there
  // makes it publish this same version again — which npm rejects (E403) and
  // fails the release after every other package has already shipped. Return
  // only once the registry serves the version we just wrote.
  for (let i = 0; i < attempts; i++) {
    const check = lookup();
    if (check.status === 0 && JSON.parse(check.stdout) === version)
      return "published";
    sleep(intervalMs);
  }
  throw new Error(
    `Published ${name}@${version} but the registry does not serve it yet; dependent publication must stop`
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { version } = JSON.parse(
    readFileSync(
      new URL("../../evaluators/package.json", import.meta.url),
      "utf8"
    )
  );
  console.log(`Evaluator dependency: ${publishEvaluatorsFirst(version)}`);
}
