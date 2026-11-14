import { describe, expect, it } from "vitest";
import { providerErrorDetails } from "../provider-error-details.js";

describe("providerErrorDetails", () => {
  it("redacts a key the provider echoes back", () => {
    const keyTail = "x".repeat(32);
    const body = `{"error":{"message":"Incorrect API key provided: sk-proj-${keyTail}"}}`;

    const details = providerErrorDetails(body);

    expect(details).not.toContain(keyTail);
    expect(details).toContain("Incorrect API key provided");
  });

  it("keeps a short body whole", () => {
    const body = '{"error":{"message":"Insufficient credits","code":402}}';

    expect(providerErrorDetails(body)).toBe(body);
  });

  it("cuts a long body without splitting a code point", () => {
    const body = "😀".repeat(9_000);

    const details = providerErrorDetails(body);

    expect(Array.from(details)).toHaveLength(8_001);
    expect(details.endsWith("😀…")).toBe(true);
  });
});
