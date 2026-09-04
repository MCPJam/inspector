/**
 * The local browser's kill switch, read where the tools are ADVERTISED.
 *
 * Its own file because `LOCAL_BROWSER_ENABLED` is resolved once at import
 * time, so flipping it means mocking the config module — and doing that in the
 * main registry suite would impose the mock on sixty tests that do not want
 * it.
 *
 * Why this matters at all: every other layer already honors the switch (the
 * routes 404, `ensureLocalBrowserSession` throws), and that is exactly what
 * made the gap easy to miss. A tool that is advertised and then fails on its
 * first call is worse than one that was never offered — the model spends a
 * turn discovering a capability the operator turned off, and the failure reads
 * as a broken page rather than a closed door.
 */
import { describe, expect, it, vi } from "vitest";

const configState = vi.hoisted(() => ({ localBrowser: true }));
vi.mock("../../config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return {
    ...actual,
    get LOCAL_BROWSER_ENABLED() {
      return configState.localBrowser;
    },
  };
});

const { resolveHostTools } = await import("../built-in-tools/registry");

const computer = { kind: "personal", workdir: "/srv" };
const localCtx = {
  authHeader: "Bearer token-123",
  projectId: "project-1",
  chatSessionId: "session-1",
  browserApprovalDelivery: { kind: "attested" as const },
  computerEngine: "local" as const,
};

describe("resolveHostTools — the local browser kill switch", () => {
  it("advertises the six tools while the switch is on", () => {
    configState.localBrowser = true;
    const tools = resolveHostTools(
      { builtInToolIds: ["browser"], computer },
      localCtx,
    );
    expect(Object.keys(tools ?? {})).toContain("browser_navigate");
  });

  it("advertises NOTHING while the switch is off, and says why", () => {
    configState.localBrowser = false;
    const suppressed: Array<{ id: string; reason: string }> = [];
    const tools = resolveHostTools(
      { builtInToolIds: ["browser"], computer },
      { ...localCtx, onToolSuppressed: (i) => suppressed.push(i) },
    );

    expect(Object.keys(tools ?? {})).not.toContain("browser_navigate");
    expect(suppressed).toEqual([
      { id: "browser", reason: expect.stringContaining("switched off") },
    ]);
  });

  it("does not quietly hand the turn to a hosted desktop instead", () => {
    // The engine answer was `local` and it cannot be served. Falling through
    // to the cloud would run — and BILL — the session somewhere the user did
    // not ask for, which is the dishonesty the engine resolver refuses to
    // commit for bash.
    configState.localBrowser = false;
    process.env.HOSTED_BROWSER_TOOLS_ENABLED = "1";
    try {
      const tools = resolveHostTools(
        { builtInToolIds: ["browser"], computer },
        localCtx,
      );
      expect(Object.keys(tools ?? {})).not.toContain("browser_navigate");
    } finally {
      delete process.env.HOSTED_BROWSER_TOOLS_ENABLED;
    }
  });
});
