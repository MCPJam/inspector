import { describe, expect, it } from "vitest";
import {
  HOSTED_APP_HANDLERS,
  qualifyHarnessHostCapabilities,
} from "../harness-host-capabilities";

describe("effective harness App capabilities", () => {
  it("accepts the installed text-only Claude handlers", () => {
    const hostStyle = "claude";
    expect(
      qualifyHarnessHostCapabilities({ hostStyle }, HOSTED_APP_HANDLERS).gaps,
    ).toEqual([]);
  });
  it.each(["codex", "chatgpt"])(
    "retains rich %s declarations until their handlers are qualified",
    (hostStyle) => {
      const result = qualifyHarnessHostCapabilities(
        { hostStyle },
        HOSTED_APP_HANDLERS,
      );
      expect(result.capabilities.message).toHaveProperty("image");
      expect(result.gaps).toContain("host-capability:message.image");
      expect(result.gaps).toContain("host-capability:updateModelContext.image");
    },
  );
  it("preserves an explicit empty declaration", () => {
    expect(
      qualifyHarnessHostCapabilities(
        { hostStyle: "claude", hostCapabilitiesOverride: {} },
        {},
      ),
    ).toEqual({ capabilities: {}, gaps: [] });
  });
  it("uses the matrix instead of the superseded legacy override", () => {
    const result = qualifyHarnessHostCapabilities(
      {
        hostStyle: "missing",
        mcpProfile: { apps: { mcpAppsOverrides: { openLinks: true } } },
        hostCapabilitiesOverride: { futureCapability: {} },
      },
      HOSTED_APP_HANDLERS,
    );
    expect(result).toEqual({ capabilities: { openLinks: {} }, gaps: [] });
  });
  it("keeps unknown claims intact and marks them unqualified", () => {
    const result = qualifyHarnessHostCapabilities(
      { hostCapabilitiesOverride: { futureCapability: {} } },
      HOSTED_APP_HANDLERS,
    );
    expect(result.capabilities).toEqual({ futureCapability: {} });
    expect(result.gaps).toEqual(["host-capability:futureCapability"]);
  });
  it.each([
    { sampling: {} },
    { message: { audio: {} } },
    { message: { text: { futureFormat: true } } },
    { serverResources: { listChanged: true } },
  ])(
    "does not qualify an unimplemented claim: %j",
    (hostCapabilitiesOverride) => {
      expect(
        qualifyHarnessHostCapabilities(
          { hostCapabilitiesOverride },
          HOSTED_APP_HANDLERS,
        ).gaps.length,
      ).toBeGreaterThan(0);
    },
  );
  it("does not qualify a declared handler that is absent", () => {
    expect(
      qualifyHarnessHostCapabilities(
        { hostCapabilitiesOverride: { logging: {} } },
        {},
      ).gaps,
    ).toEqual(["host-handler:logging"]);
  });
  it("retains explicitly enabled compatibility behavior until separately qualified", () => {
    expect(
      qualifyHarnessHostCapabilities(
        {
          hostStyle: "claude",
          mcpProfile: { apps: { compatRuntime: { openaiApps: true } } },
        },
        HOSTED_APP_HANDLERS,
      ).gaps,
    ).toContain("host-compatibility:openai-apps");
  });
  it.each(["chatgpt", "copilot", "mcpjam"])(
    "resolves the %s compatibility preset and its explicit disable",
    (hostStyle) => {
      const host = {
        hostStyle,
        hostCapabilitiesOverride: { message: { text: {} } },
      };
      expect(
        qualifyHarnessHostCapabilities(host, HOSTED_APP_HANDLERS).gaps,
      ).toEqual(["host-compatibility:openai-apps"]);
      expect(
        qualifyHarnessHostCapabilities(
          {
            ...host,
            mcpProfile: { apps: { compatRuntime: { openaiApps: false } } },
          },
          HOSTED_APP_HANDLERS,
        ).gaps,
      ).toEqual([]);
    },
  );
});
