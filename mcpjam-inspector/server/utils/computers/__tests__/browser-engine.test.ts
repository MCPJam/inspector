import { describe, it, expect, vi } from "vitest";
const state = vi.hoisted(() => ({ hosted: false, browser: true }));
vi.mock("../../../config.js", () => ({
  get HOSTED_MODE() {
    return state.hosted;
  },
  get LOCAL_BROWSER_ENABLED() {
    return state.browser;
  },
}));
vi.mock("../control-plane-client.js", () => ({
  isComputersDataPlaneConfigured: () => true,
}));
vi.mock("../remote-data-plane.js", () => ({
  getComputersRemoteDataPlaneUrl: () => null,
}));
import { resolveBrowserEngine } from "../browser-engine.js";
describe("independent Browser engine", () => {
  it("runs locally with Browser consent without consulting Bash availability or shell permission", () => {
    expect(
      resolveBrowserEngine({ preference: "local", localConsentValid: true }),
    ).toBe("local");
  });
  it("never substitutes Cloud for a denied local request", () => {
    expect(
      resolveBrowserEngine({ preference: "local", localConsentValid: false }),
    ).toBe("unavailable");
  });
  it("rejects local execution in hosted mode and with Browser disabled", () => {
    state.hosted = true;
    expect(
      resolveBrowserEngine({ preference: "local", localConsentValid: true }),
    ).toBe("unavailable");
    state.hosted = false;
    state.browser = false;
    expect(
      resolveBrowserEngine({ preference: "local", localConsentValid: true }),
    ).toBe("unavailable");
    state.browser = true;
  });
  it("resolves Cloud without local consent", () => {
    expect(
      resolveBrowserEngine({ preference: "cloud", localConsentValid: false }),
    ).toBe("e2b");
  });
});
