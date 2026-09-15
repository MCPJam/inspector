import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Changesets publishes concurrently; publish the new dependency before its SDK consumers. */
export function publishEvaluatorsFirst(
  version,
  run = (args) => spawnSync("npm", args, { encoding: "utf8" })
) {
  const name = "@mcpjam/evaluators";
  const lookup = run(["view", `${name}@${version}`, "version", "--json"]);
  if (lookup.status === 0) {
    if (JSON.parse(lookup.stdout) !== version)
      throw new Error("Unexpected evaluator registry version");
    return "already-published";
  }
  let code;
  try {
    code = JSON.parse(lookup.stdout).error?.code;
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
  return "published";
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
