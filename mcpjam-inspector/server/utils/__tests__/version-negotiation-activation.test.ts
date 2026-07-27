import { describe, expect, it } from "vitest";
import {
  AUTO_NEGOTIATION_ACTIVATION_ENABLED,
  versionNegotiationActivation,
} from "../version-negotiation-activation.js";

/**
 * Phase 5 flag mechanism: the auto-negotiation activation flag must ship OFF.
 *
 * This is the load-bearing safety guarantee for the whole PR — with the flag
 * OFF every server surface (local, hosted) resolves unconfigured connections
 * to the SDK legacy default, byte-identical to pre-activation behavior. The
 * on-by-default flip is a separate, reviewed one-line change; this test makes
 * an accidental flip fail CI.
 */
describe("auto-negotiation activation flag", () => {
  it("defaults to OFF", () => {
    expect(AUTO_NEGOTIATION_ACTIVATION_ENABLED).toBe(false);
    expect(versionNegotiationActivation()).toEqual({ enabled: false });
  });

  it("is a compile-time constant, not an env-var knob", () => {
    // The value must not depend on process.env (no fail-open toggle). Mutating
    // the environment must not change the resolved policy.
    const before = versionNegotiationActivation().enabled;
    process.env.MCPJAM_AUTO_NEGOTIATION = "true";
    try {
      expect(versionNegotiationActivation().enabled).toBe(before);
    } finally {
      delete process.env.MCPJAM_AUTO_NEGOTIATION;
    }
  });
});
