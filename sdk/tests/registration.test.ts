import { describe, expect, it } from "vitest";
import {
  AUTH_METHODS,
  DEFAULT_REGISTRATION_MODE,
  DEFAULT_REGISTRATION_STRATEGY,
  REGISTRATION_STRATEGIES,
  normalizeAuthMethod,
  normalizeRegistrationMode,
  normalizeRegistrationStrategy,
} from "../src/registration.js";

describe("registration vocabulary", () => {
  it("keeps the canonical strategy order (preregistered → cimd → dcr)", () => {
    expect(REGISTRATION_STRATEGIES).toEqual(["preregistered", "cimd", "dcr"]);
    expect(DEFAULT_REGISTRATION_STRATEGY).toBe("preregistered");
    expect(DEFAULT_REGISTRATION_MODE).toBe("auto");
  });

  describe("normalizeRegistrationStrategy", () => {
    it("passes canonical values through", () => {
      for (const value of REGISTRATION_STRATEGIES) {
        expect(normalizeRegistrationStrategy(value)).toBe(value);
      }
    });

    it("maps the legacy pre_registered spelling to preregistered", () => {
      expect(normalizeRegistrationStrategy("pre_registered")).toBe(
        "preregistered",
      );
    });

    it("rejects auto — a mode, not a concrete strategy", () => {
      expect(normalizeRegistrationStrategy("auto")).toBeUndefined();
    });

    it("returns undefined for unknown or non-string wire values", () => {
      expect(normalizeRegistrationStrategy("oidc")).toBeUndefined();
      expect(normalizeRegistrationStrategy("")).toBeUndefined();
      expect(normalizeRegistrationStrategy(undefined)).toBeUndefined();
      expect(normalizeRegistrationStrategy(null)).toBeUndefined();
      expect(normalizeRegistrationStrategy(42)).toBeUndefined();
      expect(normalizeRegistrationStrategy({})).toBeUndefined();
    });
  });

  describe("normalizeRegistrationMode", () => {
    it("admits auto in addition to every strategy", () => {
      expect(normalizeRegistrationMode("auto")).toBe("auto");
      for (const value of REGISTRATION_STRATEGIES) {
        expect(normalizeRegistrationMode(value)).toBe(value);
      }
    });

    it("maps the legacy pre_registered spelling to preregistered", () => {
      expect(normalizeRegistrationMode("pre_registered")).toBe(
        "preregistered",
      );
    });

    it("returns undefined for unknown values", () => {
      expect(normalizeRegistrationMode("automatic")).toBeUndefined();
      expect(normalizeRegistrationMode(undefined)).toBeUndefined();
    });
  });

  describe("normalizeAuthMethod", () => {
    it("passes every known method through", () => {
      for (const value of AUTH_METHODS) {
        expect(normalizeAuthMethod(value)).toBe(value);
      }
    });

    it("returns undefined for unknown values", () => {
      expect(normalizeAuthMethod("token-exchange")).toBeUndefined();
      expect(normalizeAuthMethod(undefined)).toBeUndefined();
      expect(normalizeAuthMethod(true)).toBeUndefined();
    });
  });
});
