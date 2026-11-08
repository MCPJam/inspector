import { describe, expect, it } from "vitest";
import { optionalAutomaticPluginServers } from "../optional-plugin-servers.js";
import { pendingStdioCommandApproval } from "../stdio-command-approvals.js";
import { WebRouteError, ErrorCode } from "../../routes/web/errors.js";
import {
  emitPluginServersUnavailable,
  pluginServerUnavailableReason,
  unavailablePluginServers,
} from "../plugin-server-isolation.js";
import { selectDeliverableServerIds } from "../harness/plugin-delivery.js";
const args = {
  requested: ["auto", "direct", "foreign"],
  origin: "adhoc",
  mode: "interactive" as const,
  pluginServerIds: ["auto", "direct"],
  selectedServerIds: ["direct"],
};
const refusal = () =>
  new WebRouteError(
    403,
    ErrorCode.STDIO_COMMAND_APPROVAL_REQUIRED,
    "Review command",
  );
describe("automatic plugin command approval isolation", () => {
  it("skips only resolved automatic plugin additions; direct selections still block", () => {
    const optional = optionalAutomaticPluginServers(args);
    expect([...optional]).toEqual(["auto"]);
    const direct = refusal();
    expect(
      pendingStdioCommandApproval({ auto: refusal() }, optional),
    ).toBeUndefined();
    expect(
      pendingStdioCommandApproval({ auto: refusal(), direct }, optional),
    ).toBe(direct);
    expect(pendingStdioCommandApproval({ foreign: direct }, optional)).toBe(
      direct,
    );
  });
  it.each([
    { origin: "named" },
    { origin: undefined },
    { mode: "recorded" as const },
    { requested: undefined },
  ])(
    "keeps explicit pins, unknown provenance and recordings strict (%j)",
    (override) => {
      expect([
        ...optionalAutomaticPluginServers({ ...args, ...override }),
      ]).toEqual([]);
    },
  );
  it("reports approval distinctly and excludes its tools from delivery", () => {
    const error = refusal();
    expect(pluginServerUnavailableReason(error)).toBe("needs_approval");
    const unavailable = unavailablePluginServers({
      serverIds: ["auto"],
      refused: { auto: error },
    });
    expect(unavailable[0].reason).toBe("needs_approval");
    expect(
      selectDeliverableServerIds({
        selectedServerIds: ["auto", "direct"],
        unavailableServerIds: unavailable.map((entry) => entry.serverId),
        hasLiveConfig: () => true,
      }),
    ).toEqual(["direct"]);
  });
});

it("emits only approval category and identity, without launch terms", () => {
  const chunks: unknown[] = [];
  const error = new WebRouteError(403, ErrorCode.STDIO_COMMAND_APPROVAL_REQUIRED,
    "private command", { approval: { command: "private-launch", env: { SECRET: "secret-value" } } });
  emitPluginServersUnavailable({ write: (chunk) => chunks.push(chunk) }, "chat", {
    serverIds: ["auto"], refused: { auto: error },
  });
  expect(chunks).toEqual([{ type: "data-plugin-server-unavailable", transient: true,
    data: { chatSessionId: "chat", servers: [{ serverId: "auto", reason: "needs_approval" }] } }]);
  expect(JSON.stringify(chunks)).not.toContain("private-launch");
});
