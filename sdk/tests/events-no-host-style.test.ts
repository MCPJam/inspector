import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// MCP Events code decides from what a client does: its saved delivery modes
// and the harness that runs it, never from its MCP Apps style. The style once
// stood in for a client's identity here and gave ChatGPT Work no events and
// personal ChatGPT webhooks. This keeps it out.
const REPO = path.resolve(__dirname, "../..");
const INSPECTOR = path.join(REPO, "mcpjam-inspector");
const EVENTS_MODULES = [
  path.join(INSPECTOR, "shared/client-events.ts"),
  path.join(INSPECTOR, "shared/event-agent-tools.ts"),
  path.join(INSPECTOR, "shared/events-api.ts"),
  path.join(REPO, "sdk/src/host-config/events-support.ts"),
  path.join(REPO, "sdk/src/events"),
  path.join(INSPECTOR, "client/src/components/events"),
  path.join(INSPECTOR, "client/src/components/playground/events"),
  path.join(
    INSPECTOR,
    "client/src/components/hosts/redesigned/focus/ClientEventsTab.tsx"
  ),
];

function sourceFiles(entry: string): string[] {
  let stats;
  try {
    stats = statSync(entry);
  } catch {
    // A listed module that doesn't exist yet guards nothing.
    return [];
  }
  if (stats.isFile()) return [entry];
  return readdirSync(entry, { withFileTypes: true }).flatMap((child) => {
    if (child.name === "__tests__") return [];
    const full = path.join(entry, child.name);
    if (child.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(child.name) && !/\.test\.tsx?$/.test(child.name)
      ? [full]
      : [];
  });
}

describe("Events code doesn't read hostStyle", () => {
  it("finds the Events modules", () => {
    expect(EVENTS_MODULES.flatMap(sourceFiles).length).toBeGreaterThan(10);
  });

  it("has no hostStyle in any Events module", () => {
    const hits: string[] = [];
    for (const file of EVENTS_MODULES.flatMap(sourceFiles)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (/\bhostStyle\b/.test(line)) {
            hits.push(
              `${path.relative(REPO, file)}:${index + 1}: ${line.trim()}`
            );
          }
        });
    }
    expect(hits).toEqual([]);
  });
});
