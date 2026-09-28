import { describe, expect, it } from "vitest";
import {
  resolveTurnBrowserPolicy,
  type ConversationBrowser,
} from "../chat-session-browser";
const stored: ConversationBrowser = {
  sessionId: "logical",
  browserSessionId: "logical",
  policy: { mode: "allow_all" },
  hostId: "host",
  state: "active",
};
describe("session browser authority", () => {
  it("requires an explicit ad hoc grant and allows its later reuse", () => {
    expect(() => resolveTurnBrowserPolicy({ body: {} })).toThrow(
      "Declare a browser policy",
    );
    expect(
      resolveTurnBrowserPolicy({
        body: {},
        stored: { ...stored, hostId: undefined },
      }).policy,
    ).toEqual({ mode: "allow_all" });
  });
  it("does not allow a continuation to drop its host ceiling", () => {
    expect(() => resolveTurnBrowserPolicy({ body: {}, stored })).toThrow(
      "host authority is fixed",
    );
    expect(() =>
      resolveTurnBrowserPolicy({
        body: {},
        stored,
        hostId: "host",
        hostRuntimeConfig: { builtInToolIds: [] },
      }),
    ).toThrow("does not advertise");
  });
  it("reapplies a narrowed host ceiling without replacing the stored grant", () => {
    const answer = resolveTurnBrowserPolicy({
      body: {},
      stored,
      hostId: "host",
      hostRuntimeConfig: {
        builtInToolIds: ["browser"],
        browserToolPolicy: { mode: "read_only" },
      },
    });
    expect(answer.policy.mode).toBe("allow_all");
    expect(answer.effectivePolicy.tools).not.toContain("browser_act");
  });
  it("rejects widening and intersects pinned read-only with an allowlist", () => {
    expect(() =>
      resolveTurnBrowserPolicy({
        body: { policy: { mode: "allow_all" } },
        hostId: "host",
        hostRuntimeConfig: {
          builtInToolIds: ["browser"],
          browserToolPolicy: { mode: "read_only" },
        },
      }),
    ).toThrow("exceeds the host");
    expect(
      resolveTurnBrowserPolicy({
        body: { policy: { mode: "allowlist", toolAllowlist: ["browser_act"] } },
        toolMode: "read_only",
      }).effectivePolicy.tools,
    ).toEqual([]);
  });
});
