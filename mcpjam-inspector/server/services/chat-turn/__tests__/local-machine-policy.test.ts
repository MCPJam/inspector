import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const m = vi.hoisted(() => ({
  hosted: false,
  actor: vi.fn(),
  guest: vi.fn(),
  computerConsent: vi.fn(),
  browserConsent: vi.fn(),
  rollout: vi.fn(),
  chromium: vi.fn(),
  location: vi.fn(),
}));
vi.mock("../../../config.js", async (original) => ({
  ...(await original<typeof import("../../../config.js")>()),
  get HOSTED_MODE() {
    return m.hosted;
  },
  LOCAL_COMPUTER_ENABLED: true,
  LOCAL_BROWSER_ENABLED: true,
}));
vi.mock("../../../utils/computers/local-machine.js", () => ({
  isLocalComputerEngineAvailable: () => ({ available: true }),
}));
vi.mock("../../../utils/computers/local-engine-request.js", () => ({
  classifyChatRequestActor: m.actor,
  isGuestOrAnonymousRequest: m.guest,
  isVerifiedMember: (a: { kind: string }) => a.kind === "member",
}));
vi.mock("../../../utils/computers/local-consent.js", () => ({
  LOCAL_CONSENT_HEADER: "x-computer-consent",
  verifyLocalComputerConsent: m.computerConsent,
}));
vi.mock("../../../utils/computers/browser-consent.js", () => ({
  BROWSER_CONSENT_HEADER: "x-browser-consent",
  verifyLocalBrowserConsent: m.browserConsent,
}));
vi.mock("../../../utils/computers/browser-rollout.js", () => ({
  resolveBrowserRollout: m.rollout,
}));
vi.mock("../../../utils/computers/hosted-browser-availability.js", () => ({
  isHostedBrowserAvailableFor: async () => false,
}));
vi.mock("../../../utils/browser-rendering-setup.js", () => ({
  isChromiumInstalled: m.chromium,
}));
vi.mock("../../browserd/local/local-browser-session.js", () => ({
  resolveLocalBrowserRuntime: () => "chromium",
}));
vi.mock("../../browserd/session-service.js", () => ({
  BrowserSessionService: class {
    conversationLocation = m.location;
  },
}));
import { resolveLocalMachinePolicy } from "../local-machine-policy.js";
import { BROWSER_BUILT_IN_TOOL_ID } from "@/shared/client-fulfilled-tools";
async function run(options: { scenario?: boolean; browser?: boolean } = {}) {
  const app = new Hono();
  app.get("/", async (c) =>
    c.json(
      await resolveLocalMachinePolicy({
        c,
        body: {
          computerEngine: "local",
          browserEngine: options.browser ? "local" : undefined,
          projectId: "p",
          chatSessionId: "s",
        },
        builtInToolIds: options.browser ? [BROWSER_BUILT_IN_TOOL_ID] : [],
        isScenarioSession: !!options.scenario,
      }),
    ),
  );
  return app.request("/", { headers: { authorization: "Bearer member" } });
}
describe("local machine authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.hosted = false;
    m.actor.mockResolvedValue({ kind: "member" });
    m.guest.mockResolvedValue(false);
    m.computerConsent.mockResolvedValue(true);
    m.browserConsent.mockResolvedValue(true);
    m.rollout.mockResolvedValue({
      enabled: true,
      actor: { guest: false, id: "member" },
    });
    m.chromium.mockResolvedValue(true);
    m.location.mockResolvedValue("local");
  });
  it("permits a verified member with computer consent", async () => {
    expect(await (await run()).json()).toMatchObject({
      computerEngine: "local",
    });
  });
  it("does not grant local computer access without consent", async () => {
    m.computerConsent.mockResolvedValue(false);
    expect(await (await run()).json()).not.toMatchObject({
      computerEngine: "local",
    });
  });
  it.each(["guest", "anonymous"])(
    "does not grant local computer access to %s",
    async (kind) => {
      m.actor.mockResolvedValue({ kind });
      expect(await (await run()).json()).not.toMatchObject({
        computerEngine: "local",
      });
    },
  );
  it("does not grant local machine access to a scenario", async () => {
    expect(
      await (await run({ scenario: true, browser: true })).json(),
    ).not.toMatchObject({ browserEngine: "local" });
    expect(m.browserConsent).not.toHaveBeenCalled();
  });
  it("requires browser consent", async () => {
    m.browserConsent.mockResolvedValue(false);
    expect(await (await run({ browser: true })).json()).toMatchObject({
      browserEngine: "unavailable",
      browserUnavailableReason: expect.stringContaining(
        "browser_consent_required",
      ),
    });
  });
  it("refuses missing Chromium", async () => {
    m.chromium.mockResolvedValue(false);
    expect(await (await run({ browser: true })).json()).toMatchObject({
      browserEngine: "unavailable",
      browserUnavailableReason: expect.stringContaining("Install Chromium"),
    });
  });
  it("refuses a different conversation location", async () => {
    m.location.mockResolvedValue("cloud");
    expect(await (await run({ browser: true })).json()).toMatchObject({
      browserEngine: "unavailable",
      browserUnavailableReason: expect.stringContaining(
        "browser_location_mismatch",
      ),
    });
  });
  it("allows an eligible consented browser guest without granting computer access", async () => {
    m.actor.mockResolvedValue({ kind: "guest" });
    m.rollout.mockResolvedValue({
      enabled: true,
      actor: { guest: true, id: "guest-1" },
    });
    expect(await (await run({ browser: true })).json()).toMatchObject({
      browserEngine: "local",
      localBrowserGuestId: "guest-1",
    });
  });
  it("rejects a service role before checking user capabilities", async () => {
    m.hosted = true;
    expect((await run()).status).toBe(500);
    expect(m.actor).not.toHaveBeenCalled();
  });
});
