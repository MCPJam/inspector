import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const auth = vi.hoisted(() => ({
  enabled: true,
  actor: { id: "member-a", guest: false } as {
    id: string;
    guest: boolean;
  } | null,
  fingerprint: "consent-a" as string | null,
}));
vi.mock("../../../utils/computers/browser-rollout.js", () => ({
  resolveBrowserRollout: async () => ({
    enabled: auth.enabled,
    actor: auth.actor,
  }),
}));
vi.mock("../../../utils/computers/browser-consent.js", () => ({
  BROWSER_CONSENT_HEADER: "x-mcpjam-browser-consent",
  verifyAndFingerprintBrowserConsent: async (token: string) =>
    token === "allowed" ? auth.fingerprint : null,
}));
import {
  authorizeLocalInspection,
  inspectionNonceScope,
  inspectionPartition,
  inspectionProfileKey,
} from "../local-authorization";
const app = new Hono().get("/", async (c) =>
  c.json(await authorizeLocalInspection(c, c.req.query("project"))),
);
beforeEach(() => {
  auth.enabled = true;
  auth.actor = { id: "member-a", guest: false };
  auth.fingerprint = "consent-a";
});
describe("local inspection authorization", () => {
  it("requires Browser consent independently of actor authentication", async () => {
    expect((await app.request("/")).status).toBe(403);
    expect(
      (
        await app.request("/", {
          headers: { "x-mcpjam-browser-consent": "allowed" },
        })
      ).status,
    ).toBe(200);
  });
  it.each(["disabled", "anonymous"])(
    "refuses %s access before opening a browser",
    async (kind) => {
      if (kind === "disabled") auth.enabled = false;
      else auth.actor = null;
      expect(
        (
          await app.request("/", {
            headers: { "x-mcpjam-browser-consent": "allowed" },
          })
        ).status,
      ).toBe(404);
    },
  );
  it("separates members, guests, projects and standalone profiles", async () => {
    const scope = async (project = "") =>
      (
        await app.request(`/${project ? `?project=${project}` : ""}`, {
          headers: { "x-mcpjam-browser-consent": "allowed" },
        })
      ).json();
    const first = await scope("p1"),
      same = await scope("p1"),
      second = await scope("p2"),
      standalone = await scope();
    expect(first.profileKey).toBe(same.profileKey);
    expect(
      new Set([first.profileKey, second.profileKey, standalone.profileKey])
        .size,
    ).toBe(3);
    auth.actor = { id: "member-a", guest: true };
    const guest = await scope("p1");
    expect(guest.ownerKey).not.toBe(first.ownerKey);
    expect(inspectionPartition(first)).not.toBe(inspectionPartition(guest));
    expect(inspectionPartition(first)).not.toBe("persist:webmcp-inspector");
    expect(inspectionNonceScope("one", first)).not.toBe(
      inspectionNonceScope("two", first),
    );
    expect(inspectionNonceScope("one", first)).not.toBe(
      inspectionNonceScope("one", second),
    );
    expect(() => inspectionProfileKey(first.ownerKey, "../escape")).toThrow();
  });
});
