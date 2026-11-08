import { describe, expect, it } from "vitest";
import { isNativeElicitationProfile } from "../../forwarding/native-elicitation-profile";
import { CASES, assertFullMatrix, bumpedPin } from "./support";

it("covers every registered harness", assertFullMatrix);

/** The client capabilities Claude Code's own client sends on initialize. */
const NATIVE_CAPS = {
  elicitation: { form: {}, url: {} },
  roots: { listChanged: true },
};

/**
 * Runtimes whose native initialize was read or captured and qualified for
 * elicitation. A new entry needs that runtime's own handshake first.
 */
const MEASURED_ELICITATION = new Set(["claude-code"]);

describe.each(CASES)("$id MCP delivery and input", ({ id, adapter }) => {
  it("hands its native client a config only when the harness client calls the server", () => {
    if (adapter.mcpDelivery === "harness") {
      expect(["sandbox-files", "session-config"]).toContain(
        adapter.mcpNativeDelivery,
      );
    } else {
      expect(adapter.mcpNativeDelivery).toBeUndefined();
      expect(adapter.deliverMcpServers).toBeUndefined();
    }
  });

  it("treats its native elicitation handshake as qualified only at the measured pin", () => {
    const pin = adapter.pinnedRuntimeVersion;
    expect(isNativeElicitationProfile(NATIVE_CAPS, pin)).toBe(
      MEASURED_ELICITATION.has(id),
    );
    expect(isNativeElicitationProfile(NATIVE_CAPS, bumpedPin(pin ?? "0"))).toBe(
      false,
    );
  });

  it("owns form input only through a forwarding contract", () => {
    const owned = adapter.forwardingRuntime?.ownedInput === true;
    if (!adapter.forwardingRuntime) expect(owned).toBe(false);
    if (MEASURED_ELICITATION.has(id)) expect(owned).toBe(true);
  });
});
