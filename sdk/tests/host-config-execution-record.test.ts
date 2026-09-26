import { describe, expect, it } from "vitest";

import {
  PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS,
  describeExecutionAttempts,
  describeExecutionRequest,
  formatExecutionDeviationLine,
  formatExecutionProvenanceLine,
  readExecutionRecord,
  summarizeExecutionRecord,
} from "../src/host-config/index.js";
import * as browser from "../src/browser.js";

/** A record as the backend's `executionRecordValidator` stores it. */
function gatewayRecord(overrides: Record<string, unknown> = {}) {
  return {
    requested: {
      modelId: "anthropic/claude-sonnet-4.5",
      source: "hosted",
      fallback: { provider: "none", model: "none" },
    },
    resolved: {
      rail: "gateway",
      wireModelId: "anthropic/claude-sonnet-4.5",
      offering: { rail: "gateway", providerKey: "gateway" },
    },
    effectiveSettings: { temperature: 0.2, maxOutputTokens: 4096 },
    attempts: [
      {
        rail: "gateway",
        wireModelId: "anthropic/claude-sonnet-4.5",
        outcome: "ok",
        at: 1,
      },
    ],
    ...overrides,
  };
}

describe("readExecutionRecord", () => {
  it("reads nothing from a row written before records existed", () => {
    expect(readExecutionRecord(undefined)).toBeUndefined();
    expect(readExecutionRecord(null)).toBeUndefined();
    expect(readExecutionRecord({})).toBeUndefined();
    expect(readExecutionRecord("anthropic/claude-sonnet-4.5")).toBeUndefined();
  });

  it("refuses a record missing its resolved rail rather than guessing one", () => {
    const record = gatewayRecord();
    const { rail: _rail, ...resolved } = record.resolved;
    expect(readExecutionRecord({ ...record, resolved })).toBeUndefined();
  });

  it("copies known keys only, so a stray secret never reaches a renderer", () => {
    const record = readExecutionRecord({
      ...gatewayRecord(),
      apiKey: "sk-live-should-not-survive",
      resolved: {
        ...gatewayRecord().resolved,
        headers: { authorization: "Bearer sk-live-should-not-survive" },
        offering: {
          rail: "gateway",
          providerKey: "gateway",
          sealedSecret: "sk-live-should-not-survive",
        },
      },
    });
    expect(record).toBeDefined();
    expect(JSON.stringify(record)).not.toContain("sk-live");
  });

  it("drops a malformed attempt and keeps the rest", () => {
    const record = readExecutionRecord(
      gatewayRecord({
        attempts: [
          { rail: "gateway", outcome: "error", at: 1 },
          {
            rail: "openrouter",
            wireModelId: "anthropic/claude-sonnet-4.5",
            outcome: "ok",
            at: 2,
          },
        ],
      })
    );
    expect(record?.attempts).toEqual([
      {
        rail: "openrouter",
        wireModelId: "anthropic/claude-sonnet-4.5",
        outcome: "ok",
        at: 2,
      },
    ]);
  });
});

describe("formatExecutionProvenanceLine", () => {
  it("says what ran, where, and with which settings", () => {
    const record = readExecutionRecord(
      gatewayRecord({
        harness: { id: "claude-code", runtimeVersion: "2.1.3" },
        effectiveSettings: {
          reasoningEffort: "high",
          temperature: 0.2,
          maxOutputTokens: 4096,
        },
      })
    )!;
    expect(formatExecutionProvenanceLine(record)).toBe(
      "Ran on anthropic/claude-sonnet-4.5 via Vercel AI Gateway (MCPJam key), claude-code v2.1.3, effort high, temperature 0.2, max output 4,096 tokens"
    );
  });

  it("shows the provider default ceiling as a default, never as 0 tokens", () => {
    const record = readExecutionRecord(
      gatewayRecord({
        effectiveSettings: {
          maxOutputTokens: PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS,
        },
      })
    )!;
    const line = formatExecutionProvenanceLine(record);
    expect(line).toContain("max output provider default");
    expect(line).not.toMatch(/\b0 tokens\b/);
  });

  it("names an org connection by label and provider, never by id", () => {
    const record = readExecutionRecord({
      requested: {
        modelId: "openai/gpt-5",
        source: "org",
        connectionRef: { kind: "orgProvider", id: "k17secretrowid" },
        nativeModelId: "prod-gpt5",
        fallback: { provider: "none", model: "none" },
      },
      resolved: {
        rail: "orgCloud",
        wireModelId: "gpt-5",
        connectionRef: { kind: "orgProvider", id: "k17secretrowid" },
        nativeModelId: "prod-gpt5",
        offering: {
          rail: "orgCloud",
          providerKey: "azure",
          connectionLabel: "Prod Azure",
          credentialVersion: 1_700_000_000_000,
          nativeModelId: "prod-gpt5",
        },
      },
      effectiveSettings: { maxOutputTokens: 0 },
      attempts: [],
      upstreamModel: "gpt-5-2025-08-07",
    })!;
    const line = formatExecutionProvenanceLine(record);
    expect(line).toBe(
      'Ran on gpt-5 (deployment prod-gpt5, provider reported gpt-5-2025-08-07) via org connection "Prod Azure" (azure), max output provider default'
    );
    expect(line).not.toContain("k17secretrowid");
  });

  it("names a local custom provider by its name", () => {
    const record = readExecutionRecord({
      requested: { source: "legacy", modelId: "custom:acme/model-a" },
      resolved: {
        rail: "local",
        wireModelId: "model-a",
        connectionRef: {
          kind: "localProvider",
          providerKey: "custom:acme",
          customProviderName: "acme",
        },
        offering: { rail: "local", providerKey: "custom:acme" },
      },
      effectiveSettings: { maxOutputTokens: 1024 },
      attempts: [],
    })!;
    expect(formatExecutionProvenanceLine(record)).toBe(
      "Ran on model-a via local acme key, max output 1,024 tokens"
    );
  });

  it("renders a rail a newer backend added verbatim instead of hiding the record", () => {
    const record = readExecutionRecord(
      gatewayRecord({
        resolved: {
          rail: "bedrockDirect",
          wireModelId: "m",
          offering: { rail: "bedrockDirect", providerKey: "bedrock" },
        },
      })
    );
    expect(record && formatExecutionProvenanceLine(record)).toBe(
      "Ran on m via bedrockDirect (bedrock), temperature 0.2, max output 4,096 tokens"
    );
  });
});

describe("request, attempts and deviation", () => {
  it("says a legacy request's source was inferred", () => {
    const record = readExecutionRecord(
      gatewayRecord({
        requested: { source: "legacy", modelId: "anthropic/claude-sonnet-4.5" },
      })
    )!;
    expect(describeExecutionRequest(record)).toBe(
      "Requested anthropic/claude-sonnet-4.5 (saved without a source; inferred at run time)"
    );
  });

  it("states the fallback policy of a saved selection", () => {
    const record = readExecutionRecord(gatewayRecord())!;
    expect(describeExecutionRequest(record)).toBe(
      "Requested anthropic/claude-sonnet-4.5 (MCPJam-hosted, no fallback permitted)"
    );
  });

  it("lists every attempt with its failure code, and the deviation", () => {
    const record = readExecutionRecord(
      gatewayRecord({
        requested: {
          modelId: "anthropic/claude-sonnet-4.5",
          source: "hosted",
          fallback: { provider: "openrouter", model: "none" },
        },
        attempts: [
          {
            rail: "gateway",
            wireModelId: "anthropic/claude-sonnet-4.5",
            outcome: "error",
            code: "provider_error",
            at: 1,
          },
          {
            rail: "openrouter",
            wireModelId: "anthropic/claude-sonnet-4.5",
            outcome: "ok",
            at: 2,
          },
        ],
        deviation: {
          kind: "provider_fallback",
          reason:
            "The gateway attempt failed (provider_error); the openrouter fallback served the request.",
        },
      })
    )!;
    expect(describeExecutionAttempts(record)).toEqual([
      "Attempt 1: Vercel AI Gateway · anthropic/claude-sonnet-4.5 · failed (provider_error)",
      "Attempt 2: OpenRouter · anthropic/claude-sonnet-4.5 · ok",
    ]);
    const summary = summarizeExecutionRecord(record);
    expect(summary.request).toContain("OpenRouter fallback permitted");
    expect(summary.deviation).toEqual({
      kind: "provider_fallback",
      title: "Provider fallback",
      reason:
        "The gateway attempt failed (provider_error); the openrouter fallback served the request.",
    });
    expect(formatExecutionDeviationLine(record.deviation!)).toBe(
      "Deviation: Provider fallback — The gateway attempt failed (provider_error); the openrouter fallback served the request."
    );
  });

  it("has no deviation when the record carries none", () => {
    const record = readExecutionRecord(gatewayRecord())!;
    expect(summarizeExecutionRecord(record).deviation).toBeUndefined();
  });
});

describe("exports", () => {
  it("reaches the inspector client through the browser entry", () => {
    expect(browser.readExecutionRecord).toBe(readExecutionRecord);
    expect(browser.summarizeExecutionRecord).toBe(summarizeExecutionRecord);
  });
});
