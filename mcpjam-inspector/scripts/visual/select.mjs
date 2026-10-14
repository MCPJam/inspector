import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Include transitive rendering inputs, not just the client directory. Renames
// are diffed as delete/add so moving a file out of these paths still captures.
const PREFIXES = [
  "mcpjam-inspector/client/",
  "mcpjam-inspector/shared/",
  "mcpjam-inspector/server/",
  "mcpjam-inspector/e2e/visual/",
  "mcpjam-inspector/scripts/visual/",
  "design-system/",
  "chat-ui/",
  "widget-react/",
  "sdk/",
  "evaluators/",
];
const FILES = new Set([
  "package.json",
  "package-lock.json",
  ".npmrc",
  "mcpjam-inspector/package.json",
  "mcpjam-inspector/.env.production",
  "mcpjam-inspector/Dockerfile",
  "mcpjam-inspector/playwright.visual.config.ts",
  "mcpjam-inspector/playwright.visual-auth.config.ts",
  ".github/workflows/visual-readiness.yml",
  ".github/workflows/visual.yml",
]);

export function affectsVisuals(path) {
  return FILES.has(path) || PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function selectVisualRun({ eventName, event, diff }) {
  if (eventName === "workflow_dispatch") {
    return { capture: true, reason: "manual-run", trusted: true };
  }
  if (eventName === "push" && event.ref === "refs/heads/main") {
    return { capture: true, reason: "main-always", trusted: true };
  }
  if (eventName !== "pull_request" || !event.pull_request) {
    throw new Error(
      "Visual selection requires a pull_request or main push event",
    );
  }
  const pr = event.pull_request;
  const base = pr.base?.sha;
  const head = pr.head?.sha;
  if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? ""))) {
    throw new Error("Visual selection requires immutable base and head SHAs");
  }
  const changed = diff(base, head).some(affectsVisuals);
  return {
    capture: changed,
    reason: changed ? "rendering-input-changed" : "no-rendering-input-change",
    trusted:
      pr.head.repo?.full_name === event.repository?.full_name &&
      Boolean(event.repository?.full_name) &&
      pr.user?.login !== "dependabot[bot]" &&
      event.sender?.login !== "dependabot[bot]",
  };
}

export function changedPaths(base, head, cwd = process.cwd()) {
  return execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`, "--"],
    { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
}

export function main(env = process.env) {
  if (!env.GITHUB_EVENT_PATH) throw new Error("GITHUB_EVENT_PATH is required");
  const result = selectVisualRun({
    eventName: env.GITHUB_EVENT_NAME,
    event: JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")),
    diff: changedPaths,
  });
  if (env.GITHUB_OUTPUT) {
    appendFileSync(
      env.GITHUB_OUTPUT,
      Object.entries(result)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
