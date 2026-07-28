/**
 * Tasks product policy (`src/host-config/tasks-policy.ts`).
 *
 * The invariant that matters most here is the separation: `com.mcpjam/tasks`
 * is MCPJam configuration and must never reach a server, while the wire
 * declaration is always `io.modelcontextprotocol/tasks`. The rest is the
 * tri-state and the published surface matrix.
 */

import { describe, expect, it } from "vitest";
import {
  MCPJAM_TASKS_POLICY_EXTENSION_ID,
  clearTasksPolicy,
  describeInvalidTasksPolicy,
  readTasksPolicy,
  setTasksPolicy,
  surfaceMayDeclareTasks,
  taskModeForSurface,
  type TaskSurface,
  type TasksPolicy,
} from "../src/host-config/tasks-policy.js";
import { MCP_TASKS_EXTENSION_ID } from "../src/mcp-client-manager/tasks-dispatch.js";

const hostWith = (value: unknown) => ({
  mcpProfile: { extensions: { [MCPJAM_TASKS_POLICY_EXTENSION_ID]: value } },
});

describe("the two ids are not the same thing", () => {
  it("keeps the MCPJam policy id distinct from the wire extension id", () => {
    expect(MCPJAM_TASKS_POLICY_EXTENSION_ID).toBe("com.mcpjam/tasks");
    expect(MCP_TASKS_EXTENSION_ID).toBe("io.modelcontextprotocol/tasks");
    expect(MCPJAM_TASKS_POLICY_EXTENSION_ID).not.toBe(MCP_TASKS_EXTENSION_ID);
  });

  it("stores the policy under the MCPJam id only — never under the wire id", () => {
    const host = setTasksPolicy(undefined, true);
    const extensions = host.mcpProfile?.extensions ?? {};
    expect(extensions[MCPJAM_TASKS_POLICY_EXTENSION_ID]).toEqual({
      enabled: true,
    });
    // A host config that carried the wire id would risk it being advertised.
    expect(extensions[MCP_TASKS_EXTENSION_ID]).toBeUndefined();
  });
});

describe("tri-state read", () => {
  it("reports unset when nothing was written", () => {
    expect(readTasksPolicy(undefined)).toBe("unset");
    expect(readTasksPolicy({})).toBe("unset");
    expect(readTasksPolicy({ mcpProfile: {} })).toBe("unset");
    expect(readTasksPolicy({ mcpProfile: { extensions: {} } })).toBe("unset");
  });

  it("reads on and off", () => {
    expect(readTasksPolicy(hostWith({ enabled: true }))).toBe("on");
    expect(readTasksPolicy(hostWith({ enabled: false }))).toBe("off");
  });

  it("reports invalid rather than coercing a malformed value", () => {
    // Coercion is how a typo becomes silently-enabled Tasks everywhere.
    for (const bad of [true, "yes", 1, [], null, {}, { enabled: "true" }]) {
      expect(readTasksPolicy(hostWith(bad))).toBe("invalid");
    }
  });

  it("explains what is wrong so the editor can offer a repair", () => {
    expect(describeInvalidTasksPolicy(hostWith("yes"))).toMatch(/must be an object/);
    expect(describeInvalidTasksPolicy(hostWith({ enabled: 1 }))).toMatch(
      /must be true or false/,
    );
    expect(describeInvalidTasksPolicy(hostWith({ enabled: true }))).toBeUndefined();
  });
});

describe("write and clear", () => {
  it("round-trips on and off", () => {
    expect(readTasksPolicy(setTasksPolicy(undefined, true))).toBe("on");
    expect(readTasksPolicy(setTasksPolicy(undefined, false))).toBe("off");
  });

  it("clear returns to unset, which is NOT the same as off", () => {
    const off = setTasksPolicy(undefined, false);
    expect(readTasksPolicy(off)).toBe("off");
    expect(readTasksPolicy(clearTasksPolicy(off))).toBe("unset");
    // The difference is observable: unset preserves the Tools tab's explicit
    // controls, off removes them.
    expect(taskModeForSurface("unset", "tools")).toBe("expose");
    expect(taskModeForSurface("off", "tools")).toBe("off");
  });

  it("does not mutate the input host", () => {
    const original = { mcpProfile: { extensions: { "com.other/x": {} } } };
    const snapshot = JSON.stringify(original);
    setTasksPolicy(original, true);
    clearTasksPolicy(setTasksPolicy(original, true));
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("preserves unrelated extensions through set and clear", () => {
    const host = { mcpProfile: { extensions: { "com.other/x": { a: 1 } } } };
    const enabled = setTasksPolicy(host, true);
    expect(enabled.mcpProfile.extensions["com.other/x"]).toEqual({ a: 1 });
    const cleared = clearTasksPolicy(enabled);
    expect(cleared.mcpProfile.extensions["com.other/x"]).toEqual({ a: 1 });
    expect(
      cleared.mcpProfile.extensions[MCPJAM_TASKS_POLICY_EXTENSION_ID],
    ).toBeUndefined();
  });

  it("preserves other mcpProfile fields", () => {
    const host = { mcpProfile: { profileVersion: 1 as const } };
    expect(setTasksPolicy(host, true).mcpProfile.profileVersion).toBe(1);
  });
});

describe("the published surface matrix", () => {
  const matrix: Array<[TaskSurface, Record<TasksPolicy, string>]> = [
    ["tools", { unset: "expose", on: "expose", off: "off", invalid: "off" }],
    ["chat", { unset: "off", on: "expose", off: "off", invalid: "off" }],
    ["agent", { unset: "off", on: "expose", off: "off", invalid: "off" }],
    ["eval", { unset: "off", on: "await", off: "off", invalid: "off" }],
    [
      "conformance",
      { unset: "expose", on: "expose", off: "off", invalid: "off" },
    ],
    ["replay", { unset: "off", on: "off", off: "off", invalid: "off" }],
    ["api", { unset: "expose", on: "expose", off: "off", invalid: "off" }],
  ];

  for (const [surface, expected] of matrix) {
    for (const policy of Object.keys(expected) as TasksPolicy[]) {
      it(`${surface} under ${policy} → ${expected[policy]}`, () => {
        expect(taskModeForSurface(policy, surface)).toBe(expected[policy]);
      });
    }
  }

  it("never creates work on a replay surface, whatever the policy says", () => {
    for (const policy of ["unset", "on", "off", "invalid"] as TasksPolicy[]) {
      expect(taskModeForSurface(policy, "replay")).toBe("off");
      expect(surfaceMayDeclareTasks(policy, "replay")).toBe(false);
    }
  });

  it("turns everything off on an explicit Off, including the Tools controls", () => {
    const surfaces: TaskSurface[] = [
      "tools",
      "chat",
      "agent",
      "eval",
      "conformance",
      "replay",
      "api",
    ];
    for (const surface of surfaces) {
      expect(surfaceMayDeclareTasks("off", surface)).toBe(false);
    }
  });

  it("fails closed on an invalid policy — identically to off", () => {
    const surfaces: TaskSurface[] = ["tools", "chat", "agent", "eval", "api"];
    for (const surface of surfaces) {
      expect(taskModeForSurface("invalid", surface)).toBe(
        taskModeForSurface("off", surface),
      );
    }
  });

  it("leaves newly-supported surfaces off when the host never opted in", () => {
    // The point of `unset`: adding a Tasks-capable surface is a non-event for
    // a host that never expressed an opinion.
    for (const surface of ["chat", "agent", "eval"] as TaskSurface[]) {
      expect(taskModeForSurface("unset", surface)).toBe("off");
    }
  });

  it("drives automation to a terminal result rather than exposing a handle", () => {
    // Nobody is watching a tab during an eval, so a handle nobody follows is
    // the same as a hang.
    expect(taskModeForSurface("on", "eval")).toBe("await");
    expect(taskModeForSurface("on", "chat")).toBe("expose");
  });
});
