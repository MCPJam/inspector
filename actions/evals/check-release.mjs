import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function checkSmokeRun(run, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? ""))
    throw new Error("A full commit SHA is required.");
  if (
    run.repository?.full_name !== "MCPJam/inspector" ||
    run.path?.split("@")[0] !== ".github/workflows/evals-action-smoke.yml" ||
    run.event !== "workflow_dispatch" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.head_sha !== sha
  ) {
    throw new Error(
      "Release requires a successful live smoke run for this exact Inspector commit.",
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [runId, sha] = process.argv.slice(2);
    if (!/^\d+$/.test(runId ?? ""))
      throw new Error("A numeric GitHub smoke run ID is required.");
    const run = JSON.parse(
      execFileSync(
        "gh",
        ["api", `repos/MCPJam/inspector/actions/runs/${runId}`],
        { encoding: "utf8" },
      ),
    );
    checkSmokeRun(run, sha);
    process.stdout.write(
      `Live smoke verified for ${sha}. This command does not publish tags.\n`,
    );
  } catch {
    process.stderr.write(
      "Release check failed: verify gh authentication, the smoke run ID, and the exact commit SHA.\n",
    );
    process.exitCode = 1;
  }
}
