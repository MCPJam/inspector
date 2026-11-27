import { describe, expect, it } from "vitest";
import {
  describeContextLengthExceeded,
  isContextLengthExceededCode,
} from "../context-length-exceeded";

describe("describeContextLengthExceeded", () => {
  it("states the counts when the provider gave them", () => {
    const described = describeContextLengthExceeded(
      '{"message":"prompt is too long: 596303 tokens > 200000 maximum"}',
    );

    expect(described.title).toBe("Chat too long for this model");
    expect(described.oneLine).toBe(
      "This chat has 596,303 tokens, and the model accepts up to 200,000.",
    );
  });

  it("keeps the catalog sentence when they did not", () => {
    expect(
      describeContextLengthExceeded("Input is too long for requested model.")
        .oneLine,
    ).toBe("This chat is longer than the model's context window.");
    expect(describeContextLengthExceeded(undefined).oneLine).toBe(
      "This chat is longer than the model's context window.",
    );
  });
});

describe("isContextLengthExceededCode", () => {
  it("is only the backend's code", () => {
    expect(isContextLengthExceededCode("context_length_exceeded")).toBe(true);
    expect(isContextLengthExceededCode("provider_error")).toBe(false);
    expect(isContextLengthExceededCode(undefined)).toBe(false);
  });
});
