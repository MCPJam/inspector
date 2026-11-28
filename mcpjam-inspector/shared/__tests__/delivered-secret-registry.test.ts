import { describe, expect, it } from "vitest";
import {
  hasDeliveredSecrets,
  registerDeliveredSecret,
  scrubDeliveredSecrets,
  scrubDeliveredSecretsDeep,
} from "../delivered-secret-registry";

describe("delivered secret registry", () => {
  it("passes text through untouched until something is registered", () => {
    expect(hasDeliveredSecrets()).toBe(false);
    expect(scrubDeliveredSecrets("tok_EFTW41_SECRET_a")).toBe(
      "tok_EFTW41_SECRET_a",
    );
  });

  it("replaces a registered value exactly, in text and in nested values", () => {
    registerDeliveredSecret("tok_EFTW41_SECRET_exact", "oauth-token");
    registerDeliveredSecret("short", "oauth-token");
    registerDeliveredSecret(undefined, "oauth-token");

    expect(scrubDeliveredSecrets("x tok_EFTW41_SECRET_exact y short")).toBe(
      "x [redacted-oauth-token] y short",
    );
    expect(
      scrubDeliveredSecretsDeep({
        list: ["tok_EFTW41_SECRET_exact"],
        tok_EFTW41_SECRET_exact: 1,
      }),
    ).toEqual({ list: ["[redacted-oauth-token]"], "[redacted-oauth-token]": 1 });
  });

  it("keeps the newest values once it is full", () => {
    const value = (index: number) => `tok_EFTW41_SECRET_${String(index).padStart(4, "0")}`;
    registerDeliveredSecret(value(0), "oauth-token");
    registerDeliveredSecret(value(1), "oauth-token");
    for (let index = 2; index < 300; index += 1) {
      registerDeliveredSecret(value(index), "oauth-token");
      // Re-registered, so it counts as new and stays.
      registerDeliveredSecret(value(1), "oauth-token");
    }
    expect(scrubDeliveredSecrets(value(0))).toBe(value(0));
    expect(scrubDeliveredSecrets(value(1))).toBe("[redacted-oauth-token]");
    expect(scrubDeliveredSecrets(value(299))).toBe("[redacted-oauth-token]");
  });

  it("never pushes out a value a live connection still sends", () => {
    const value = (index: number) =>
      `tok_EFTW41_HELD_${String(index).padStart(4, "0")}`;
    // A token that never expires: registered once, at connect.
    const connection = {};
    registerDeliveredSecret("tok_EFTW41_HELD_forever", "oauth-token", connection);
    for (let index = 0; index < 300; index += 1) {
      registerDeliveredSecret(value(index), "oauth-token");
    }
    expect(scrubDeliveredSecrets("tok_EFTW41_HELD_forever")).toBe(
      "[redacted-oauth-token]",
    );
    // Once that connection sends a new value, the old one ages out normally.
    registerDeliveredSecret("tok_EFTW41_HELD_next", "oauth-token", connection);
    for (let index = 300; index < 600; index += 1) {
      registerDeliveredSecret(value(index), "oauth-token");
    }
    expect(scrubDeliveredSecrets("tok_EFTW41_HELD_forever")).toBe(
      "tok_EFTW41_HELD_forever",
    );
    expect(scrubDeliveredSecrets("tok_EFTW41_HELD_next")).toBe(
      "[redacted-oauth-token]",
    );
  });
});
