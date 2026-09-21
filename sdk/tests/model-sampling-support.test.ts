import { describe, expect, it } from "vitest";
import { modelRejectsTemperature } from "../src/model-sampling-support";

describe("modelRejectsTemperature", () => {
  it("matches the affected families across every id shape we accept", () => {
    const ids = [
      // Hosted / prefixed, dot-separated version.
      "anthropic/claude-opus-4.7",
      "anthropic/claude-opus-4.8",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-fable-5",
      // Bedrock inference profiles: geo prefix, dashed version, date + revision.
      "us.anthropic.claude-opus-4-7-20260205-v1:0",
      "eu.anthropic.claude-sonnet-5-20260401-v1:0",
      "global.anthropic.claude-opus-5-20260601-v1:0",
      // Bedrock ARN.
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-8-20260310-v1:0",
      // Bare (custom / anthropic-compatible providers).
      "claude-opus-5",
      "claude-mythos-5",
      // Versions past the threshold, including a two-digit minor, must match
      // without anyone editing this file when they ship.
      "anthropic/claude-opus-4.9",
      "anthropic/claude-opus-4.10",
      "us.anthropic.claude-opus-4-9-20260801-v1:0",
      "anthropic/claude-opus-6",
    ];
    for (const id of ids) {
      expect(modelRejectsTemperature(id), id).toBe(true);
    }
  });

  it("holds a family it has never heard of to the 5 threshold", () => {
    // Every family that reached a 5 generation dropped the sampling params, so
    // an id this file predates is assumed to follow rather than 400 on the user.
    // Haiku is the live case; the invented names stand in for the next tier.
    const rejects = [
      "anthropic/claude-haiku-5",
      "claude-haiku-5",
      "us.anthropic.claude-haiku-5-20260301-v1:0",
      "anthropic/claude-haiku-5.2",
      "anthropic/claude-quartet-5",
      "claude-quartet-7",
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-quartet-6-20270101-v1:0",
    ];
    for (const id of rejects) {
      expect(modelRejectsTemperature(id), id).toBe(true);
    }

    // Below the threshold an unlisted family is left alone.
    const accepts = ["anthropic/claude-quartet-4", "claude-quartet-4-9"];
    for (const id of accepts) {
      expect(modelRejectsTemperature(id), id).toBe(false);
    }
  });

  it("leaves models that still accept temperature alone", () => {
    const ids = [
      "anthropic/claude-opus-4.6",
      "anthropic/claude-opus-4.6-fast",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-haiku-4.5",
      "claude-sonnet-4-5",
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      "openai/gpt-4o-mini",
      // A bare major on Bedrock is followed by the release date; it must not be
      // read as a minor version, which would push Opus 4 over the 4.7 threshold.
      "anthropic.claude-opus-4-20250514-v1:0",
      "anthropic/claude-opus-4",
      // Unlisted families are only assumed to reject from 5 onward — every
      // shipped Haiku is below that and keeps its temperature.
      "anthropic/claude-haiku-4",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      // Legacy "claude-<major>-<family>" ordering must not parse as a version.
      "anthropic.claude-3-opus-20240229-v1:0",
      // Ollama bare ids must not false-positive.
      "llama3.1:8b",
      "mistral:latest",
    ];
    for (const id of ids) {
      expect(modelRejectsTemperature(id), id).toBe(false);
    }
  });

  it("cannot see through an opaque Bedrock ARN (known gap)", () => {
    // These name a resource, not a model, so an affected family behind one is
    // invisible here and still sends the field. Pinned so the limit is a
    // recorded gap rather than a surprise; closing it needs a Bedrock API call.
    const ids = [
      "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123xyz",
      "arn:aws:bedrock:us-east-1:123456789012:provisioned-model/xyz789",
    ];
    for (const id of ids) {
      expect(modelRejectsTemperature(id), id).toBe(false);
    }
  });
});
