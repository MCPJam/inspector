/**
 * claude.ai's Free plan gets a different connector page ("Your plugins" under
 * `/plugins`, an "Add" menu instead of "Add connector"), seen live in
 * HARN-139. MCPJam refuses it before any connector on the account changes.
 */
import { describe, expect, it, vi } from "vitest";
import { claudeWebPageModule } from "../claude-web";
import type { PageDriver } from "../page-driver";
import { webClientFailureMessage } from "../../../../services/web-clients/web-client-harness-turn";

const connector = { name: "MCPJam orders 1a2b3c4d", url: "https://inspector.example/mcp/connector-1" };
const ctx = { timeoutMs: 300 };

/** A connector page that lands on `landing` and shows `texts`. */
function connectorPage(landing: string, texts: Record<string, string>): PageDriver {
  let url = "https://claude.ai/new";
  return {
    kind: "playwright",
    canEvaluate: true,
    playwrightSelectors: true,
    async navigate(next) {
      url = next.endsWith("/customize/connectors/yours") ? landing : next;
    },
    async url() {
      return url;
    },
    async evaluate(fn, arg) {
      return fn(arg);
    },
    waitFor: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    async readText(selector) {
      return texts[selector];
    },
  };
}

const FREE_REFUSAL = {
  failure: {
    kind: "plan_limit",
    step: "connector",
    message:
      "This Claude account is on the Free plan, which MCPJam can't run yet. Sign in with a Pro, Max, Team or Enterprise account, then run again.",
  },
};

describe("claude.ai on the Free plan", () => {
  it("stops when the connector page redirects to Your plugins", async () => {
    const driver = connectorPage("https://claude.ai/plugins/yours", {});
    await expect(claudeWebPageModule.ensureConnector(driver, connector, ctx)).rejects.toMatchObject(FREE_REFUSAL);
    expect(driver.click).not.toHaveBeenCalled();
    expect(driver.type).not.toHaveBeenCalled();
  });

  it("stops when the page shows Your plugins with no Add connector", async () => {
    const driver = connectorPage("https://claude.ai/customize/connectors/yours", {
      ".dframe-pane-primary >> text=Your plugins": "Your plugins",
    });
    await expect(claudeWebPageModule.ensureConnector(driver, connector, ctx)).rejects.toMatchObject(FREE_REFUSAL);
    expect(driver.click).not.toHaveBeenCalled();
  });

  it("goes on when the paid page's Add connector is there", async () => {
    const driver = connectorPage("https://claude.ai/customize/connectors/yours", {
      ".dframe-pane-primary >> text=Your plugins": "Your plugins",
      '.dframe-pane-primary >> role=button[name="Add connector"]': "Add connector",
    });
    // Past the plan check, the fake page has no connector list to drive.
    await expect(claudeWebPageModule.ensureConnector(driver, connector, ctx)).rejects.not.toMatchObject({
      failure: { kind: "plan_limit" },
    });
  });

  it("reaches the chat as the plan message, not a retry", () => {
    expect(webClientFailureMessage("Claude", FREE_REFUSAL.failure as never)).toBe(
      `${FREE_REFUSAL.failure.message} The server was not graded.`,
    );
  });
});
