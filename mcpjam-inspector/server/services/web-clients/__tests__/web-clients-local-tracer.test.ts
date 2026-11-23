/**
 * What the local tracer prints when its turn stops: the step and the
 * failure, never the connector's URL or id, since the id is the connector's
 * credential. And its check that the signed-in browser profile stays outside
 * the repository.
 */
import { join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isOutsideRepository, stoppedLine } from "../../../../scripts/web-clients-local-tracer";

const connector = {
  url: "https://tunnel.example/mcp/c2VjcmV0LWNvbm5lY3Rvci1pZC0xMjM0",
  id: "c2VjcmV0LWNvbm5lY3Rvci1pZC0xMjM0",
};

describe("the local tracer's failure line", () => {
  it("leaves out the connector URL and id a driver error quotes", () => {
    // Playwright's message for a fill that timed out quotes the value it typed.
    const message = [
      "locator.fill: Timeout 15000ms exceeded.",
      "Call log:",
      `  - fill("${connector.url}")`,
      "  - element is not enabled",
    ].join("\n");
    const line = stoppedLine({ kind: "driver", step: "connector", message }, connector);
    expect(line).not.toContain(connector.id);
    expect(line).toContain("The tracer stopped at connector: locator.fill: Timeout 15000ms exceeded.");
    expect(line).toContain('fill("<connector URL>")');
    expect(line).toContain("element is not enabled");
    expect(
      stoppedLine({ kind: "needs_sign_in", step: "sign_in_check", message: `Connector ${connector.id} is signed out.` }, connector),
    ).toMatch(/^Needs sign-in: Connector <connector id> is signed out\. Run this command with --sign-in/);
  });
});

describe("the local tracer's check that the profile is outside the repository", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("finds the repository from the script, wherever the command runs from", () => {
    const repo = fileURLToPath(new URL("../../../../..", import.meta.url));
    // Inside the checkout, the working directory's parent is not its root.
    vi.spyOn(process, "cwd").mockReturnValue(join(repo, "mcpjam-inspector", "server"));
    expect(isOutsideRepository(join(repo, "sdk", "claude-profile"))).toBe(false);
    expect(isOutsideRepository(join(repo, "..", "claude-profile"))).toBe(true);
  });

  it("counts a folder on another Windows drive as outside", () => {
    const root = "C:\\src\\inspector";
    expect(isOutsideRepository("D:\\profiles\\claude", { root, paths: win32 })).toBe(true);
    expect(isOutsideRepository("C:\\Users\\me\\claude-profile", { root, paths: win32 })).toBe(true);
    expect(isOutsideRepository("C:\\src\\inspector\\claude-profile", { root, paths: win32 })).toBe(false);
    // A folder whose name starts with two dots is still inside.
    expect(isOutsideRepository("/src/inspector/..profile", { root: "/src/inspector", paths: posix })).toBe(false);
  });
});
