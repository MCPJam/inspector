/**
 * What the local tracer prints when its turn stops: the step and the
 * failure, never the connector's URL or id, since the id is the connector's
 * credential. Its check that the profile stays outside the repository is the
 * server's own, tested in outside-repository.test.ts.
 */
import { describe, expect, it } from "vitest";
import { stoppedLine } from "../../../../scripts/web-clients-local-tracer";

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
