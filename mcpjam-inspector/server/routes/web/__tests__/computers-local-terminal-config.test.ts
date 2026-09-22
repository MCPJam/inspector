import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * `GET /api/web/computers/config` is how the CLIENT learns whether to offer the
 * local terminal at all. This suite pins the flip in both directions with the
 * node-pty probe stubbed — the sibling `computers.test.ts` composes its
 * expectation from the real probe (honest on any host), which by construction
 * can't assert the `true` branch on a CI box that has no native addon.
 */

// No `config.js` mock here on purpose: both consumers of HOSTED_MODE /
// LOCAL_COMPUTER_ENABLED on this route's config path (`local-machine`,
// `local-pty`) are mocked below, and `createComputersRoutes` never reads
// `config.js` itself. The sibling `computers.test.ts` needs that mock precisely
// because it exercises the REAL probes.
const engineState = vi.hoisted(() => ({
  engine: { available: true } as
    | { available: true }
    | { available: false; reason: string },
}));
vi.mock("../../../utils/computers/local-machine.js", () => ({
  isLocalComputerEngineAvailable: () => engineState.engine,
}));

const terminalState = vi.hoisted(() => ({
  terminal: { available: true } as
    | { available: true }
    | { available: false; reason: string },
}));
vi.mock("../../../utils/computers/local-pty.js", () => ({
  getLocalTerminalAvailability: async () => terminalState.terminal,
}));

import { createComputersRoutes } from "../computers.js";

/**
 * Keep the control plane out of it: `/config` also resolves
 * `resolveComputersLocalConfigured()` / `resolveComputersRemoteDataPlaneUrl()`,
 * which would make real outbound calls (with retries) if CONVEX_HTTP_URL happens
 * to be set in the environment — slow, and order-dependent through their
 * memoized discovery promises.
 */
function installFetchStub() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 404 }))
  );
}

function createApp() {
  const app = new Hono();
  app.route("/api/web/computers", createComputersRoutes());
  return app;
}

async function readLocalEngineBlock(): Promise<Record<string, unknown>> {
  const response = await createApp().request("/api/web/computers/config");
  const json = (await response.json()) as {
    engines: { local: Record<string, unknown> };
  };
  return json.engines.local;
}

beforeEach(() => {
  installFetchStub();
  engineState.engine = { available: true };
  terminalState.terminal = { available: true };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/web/computers/config — local terminal probe", () => {
  it("reports terminalAvailable:true once node-pty loads", async () => {
    await expect(readLocalEngineBlock()).resolves.toMatchObject({
      available: true,
      terminalAvailable: true,
      workspaceDisplayRoot: "~/.mcpjam/computer",
    });
  });

  it("reports terminalAvailable:false when node-pty is missing — engine still on", async () => {
    terminalState.terminal = {
      available: false,
      reason: "node-pty is not available on this server",
    };
    // The honest degrade: bash from chat keeps working, the client renders the
    // terminal-off state instead of a broken pane.
    await expect(readLocalEngineBlock()).resolves.toMatchObject({
      available: true,
      terminalAvailable: false,
    });
  });

  it("never offers a terminal when the local engine itself is unavailable", async () => {
    engineState.engine = {
      available: false,
      reason: "the local computer engine is disabled on this server",
    };
    terminalState.terminal = {
      available: false,
      reason: "the local computer engine is disabled on this server",
    };
    await expect(readLocalEngineBlock()).resolves.toMatchObject({
      available: false,
      terminalAvailable: false,
      workspaceDisplayRoot: null,
    });
  });

  it("does not leak an absolute home path or OS username", async () => {
    const block = await readLocalEngineBlock();
    expect(String(block.workspaceDisplayRoot)).toBe("~/.mcpjam/computer");
    expect(JSON.stringify(block)).not.toContain("/home/");
    expect(JSON.stringify(block)).not.toContain("/Users/");
  });
});
