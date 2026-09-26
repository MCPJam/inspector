import { describe, expect, it } from "vitest";
import {
  API_KEY_EXPIRY_OPTIONS,
  DEFAULT_API_KEY_EXPIRY_DAYS,
  describeApiKeyExpiry,
  formatExpiryOption,
  isApiKeyExpired,
} from "../api-key-expiry";

const NOW = Date.parse("2026-09-23T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

describe("describeApiKeyExpiry", () => {
  it("reads a key with no expiry as not expiring, never as expired", () => {
    for (const value of [null, undefined, "", "not a date"]) {
      expect(describeApiKeyExpiry(value, NOW)).toEqual({
        state: "none",
        label: "No expiry",
      });
      expect(isApiKeyExpired(value, NOW)).toBe(false);
    }
  });

  it("marks a key past its expiry as expired", () => {
    const expiresAt = new Date(NOW - DAY_MS).toISOString();
    expect(describeApiKeyExpiry(expiresAt, NOW).state).toBe("expired");
    expect(describeApiKeyExpiry(expiresAt, NOW).label).toMatch(/^Expired /);
    expect(isApiKeyExpired(expiresAt, NOW)).toBe(true);
  });

  it("counts down the last two weeks", () => {
    expect(
      describeApiKeyExpiry(new Date(NOW + 3 * DAY_MS).toISOString(), NOW),
    ).toEqual({ state: "expiring", label: "Expires in 3 days" });
    expect(
      describeApiKeyExpiry(new Date(NOW + 60_000).toISOString(), NOW),
    ).toEqual({ state: "expiring", label: "Expires in 1 day" });
  });

  it("gives the date for a key further out", () => {
    const expiresAt = new Date(NOW + 90 * DAY_MS).toISOString();
    const expiry = describeApiKeyExpiry(expiresAt, NOW);
    expect(expiry.state).toBe("active");
    expect(expiry.label).toBe(
      `Expires ${new Date(expiresAt).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })}`,
    );
  });
});

describe("expiry options", () => {
  it("offers the default, stays within the server's 1–365 day bound, and has no 'never'", () => {
    expect(API_KEY_EXPIRY_OPTIONS).toContain(DEFAULT_API_KEY_EXPIRY_DAYS);
    for (const days of API_KEY_EXPIRY_OPTIONS) {
      expect(days).toBeGreaterThanOrEqual(1);
      expect(days).toBeLessThanOrEqual(365);
    }
    expect(formatExpiryOption(365)).toBe("1 year");
    expect(formatExpiryOption(90)).toBe("90 days");
  });
});
