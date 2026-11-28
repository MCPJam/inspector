import { describe, expect, it } from "vitest";
import {
  MCPJAM_EVENTS_EXTENSION_ID,
  type EventDeliveryMode,
} from "@mcpjam/sdk/browser";
import { describeClientEvents } from "../client-events";

function client(
  events: unknown,
  extra: { harness?: string; agentLoop?: string; hostStyle?: string } = {},
) {
  return {
    hostStyle: "mcpjam",
    ...extra,
    mcpProfile:
      events === undefined
        ? undefined
        : {
            profileVersion: 1,
            extensions: { [MCPJAM_EVENTS_EXTENSION_ID]: events },
          },
  };
}

const ALL = { poll: true, push: true, webhook: true };

describe("describeClientEvents", () => {
  it("S1: an MCPJam client with every mode, local, is editable and the agent can subscribe by poll or push", () => {
    const view = describeClientEvents(client(ALL), { runtime: "local" });
    expect(view).toMatchObject({
      modes: ["poll", "push", "webhook"],
      setting: "valid",
      editable: true,
      usableModes: ["poll", "push", "webhook"],
      agentTools: { available: true, modes: ["poll", "push"] },
    });
    expect(view.harness).toBeUndefined();
  });

  it("S2: all modes off gives the agent no tools, with the reason", () => {
    expect(
      describeClientEvents(client({}), { runtime: "hosted" }).agentTools,
    ).toEqual({ available: false, reason: "no-modes" });
  });

  it("S3: ChatGPT Work's webhook works for the agent hosted, not locally", () => {
    const work = client({ webhook: true }, { hostStyle: "chatgpt-work" });
    expect(
      describeClientEvents(work, { runtime: "hosted" }).agentTools,
    ).toEqual({ available: true, modes: ["webhook"] });
    const local = describeClientEvents(work, { runtime: "local" });
    expect(local.usableModes).toEqual(["webhook"]);
    expect(local.agentTools).toEqual({
      available: false,
      reason: "local-webhook",
    });
  });

  it("S4: a vendor harness receives nothing, read-only, named", () => {
    for (const extra of [{ harness: "codex" }, { agentLoop: "claude-code" }]) {
      const view = describeClientEvents(client(ALL, extra), {
        runtime: "hosted",
      });
      expect(view.modes).toEqual([]);
      expect(view.editable).toBe(false);
      expect(view.agentTools).toEqual({ available: false, reason: "harness" });
    }
    expect(
      describeClientEvents(client(ALL, { harness: "codex" }), {
        runtime: "local",
      }).harness,
    ).toEqual({ id: "codex", name: "Codex" });
  });

  it("S5: Push only, hosted, has no usable mode", () => {
    const view = describeClientEvents(client({ push: true }), {
      runtime: "hosted",
    });
    expect(view.usableModes).toEqual([]);
    expect(view.agentTools).toEqual({ available: false, reason: "runtime" });
  });

  it("S6: an unreadable setting receives nothing and says so", () => {
    const view = describeClientEvents(client({ sse: true }), {
      runtime: "local",
    });
    expect(view.setting).toBe("invalid");
    expect(view.modes).toEqual([]);
    expect(view.agentTools).toEqual({ available: false, reason: "invalid" });
  });

  it("S7: a viewer without edit rights can't change it", () => {
    expect(
      describeClientEvents(client(ALL), { runtime: "local", readOnly: true })
        .editable,
    ).toBe(false);
  });

  it("ignores the Apps style: nothing saved means no events", () => {
    const view = describeClientEvents(client(undefined), { runtime: "local" });
    expect(view.setting).toBe("unset");
    expect(view.modes).toEqual([]);
    expect(view.agentTools).toEqual({ available: false, reason: "no-modes" });
  });

  it("treats no config as MCPJam (built-in): every mode, not editable, tools on", () => {
    for (const runtime of ["hosted", "local"] as const) {
      const view = describeClientEvents(null, { runtime });
      expect(view.modes).toEqual(["poll", "push", "webhook"]);
      expect(view.setting).toBe("valid");
      expect(view.editable).toBe(false);
      expect(view.agentTools.available).toBe(true);
    }
  });

  it("lists modes in spec order whatever order they were saved in", () => {
    const modes: EventDeliveryMode[] = describeClientEvents(
      client({ webhook: true, poll: true }),
      { runtime: "hosted" },
    ).usableModes;
    expect(modes).toEqual(["poll", "webhook"]);
  });
});
