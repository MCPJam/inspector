/**
 * The client rule `tasks-wire-resolvable` used to grade as a server check.
 *
 * That check passed whenever a protocol version was negotiated, which every
 * successful connection has, so it scored a point for every server, even one
 * with no tasks at all. What it actually covered is client logic: which tasks
 * wire MCPJam picks from the negotiated version and the server's declared
 * capabilities. That logic is pinned here, in CI, where a mistake fails our
 * build instead of a user's server.
 *
 * The rules the picker follows:
 *   - 2025-11-25 tasks (`basic/utilities/tasks`, Capabilities): a server
 *     declares `tasks.list`, `tasks.cancel` and/or `tasks.requests.tools.call`.
 *   - ext-tasks 2026-07-28 (`tasks.md`, Capability Negotiation): a server
 *     declares `capabilities.extensions["io.modelcontextprotocol/tasks"]`.
 *   - SEP-2663: on 2025-11-25 the extension capability is treated as absent;
 *     the core utility is the only wire there.
 *   - Earlier revisions have no tasks; an unknown or missing version fails
 *     closed to no wire.
 */

import { describe, expect, it } from "vitest";
import {
  resolveTasksSupport,
  resolveTasksWire,
} from "../src/mcp-client-manager/tasks-dispatch.js";

const EXT_ID = "io.modelcontextprotocol/tasks";
const LEGACY = {
  tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
};
const EXTENSION = { extensions: { [EXT_ID]: {} } };
const BOTH = { ...LEGACY, ...EXTENSION };

describe("the tasks wire MCPJam picks", () => {
  it.each([
    // A server that declares both forms gets the form its version speaks.
    ["2025-11-25", BOTH, "legacy"],
    ["2026-07-28", BOTH, "extension"],
    // Each form on the other revision is not a wire.
    ["2025-11-25", EXTENSION, "none"],
    ["2026-07-28", LEGACY, "none"],
    // Any one legacy sub-capability puts 2025-11-25 on the legacy wire.
    ["2025-11-25", { tasks: { cancel: {} } }, "legacy"],
    ["2025-11-25", { tasks: { list: {} } }, "legacy"],
    ["2025-11-25", { tasks: { requests: { tools: { call: {} } } } }, "legacy"],
    // Declaring nothing, or an empty tasks object, is no wire.
    ["2025-11-25", { tasks: {} }, "none"],
    ["2025-11-25", {}, "none"],
    ["2026-07-28", {}, "none"],
    // A malformed extension declaration is not support.
    ["2026-07-28", { extensions: { [EXT_ID]: true } }, "none"],
    ["2026-07-28", { extensions: { [EXT_ID]: null } }, "none"],
    ["2026-07-28", { extensions: "tasks" }, "none"],
    // Revisions before tasks, and versions we cannot place, fail closed.
    ["2025-06-18", BOTH, "none"],
    ["2025-03-26", BOTH, "none"],
    ["2099-01-01", BOTH, "none"],
    [undefined, BOTH, "none"],
  ] as const)("%s with %j resolves to %s", (version, capabilities, wire) => {
    expect(resolveTasksWire(version, capabilities as never)).toBe(wire);
    expect(resolveTasksSupport(version, capabilities as never).wire).toBe(wire);
  });

  it("always resolves to exactly one wire", () => {
    // What the removed check's title promised. The resolver returns one value
    // by construction; this pins that it is always one of the three.
    const versions = [
      undefined,
      "2025-03-26",
      "2025-06-18",
      "2025-11-25",
      "2026-07-28",
      "x",
    ];
    const capabilities = [
      undefined,
      {},
      LEGACY,
      EXTENSION,
      BOTH,
      { tasks: null },
    ];
    for (const version of versions) {
      for (const caps of capabilities) {
        expect(["legacy", "extension", "none"]).toContain(
          resolveTasksWire(version, caps as never)
        );
      }
    }
  });

  it("offers no task operation on no wire", () => {
    expect(resolveTasksSupport("2025-11-25", { tasks: {} } as never)).toEqual({
      wire: "none",
      toolCalls: false,
      list: false,
      cancel: false,
      update: false,
      inlineResult: false,
    });
  });
});
