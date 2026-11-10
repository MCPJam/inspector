import { describe, expect, it } from "vitest";
import { HARNESS_IDS } from "@mcpjam/sdk/host-config/internal";
import { HARNESS_DESCRIPTORS } from "../harness-descriptors";
import {
  connectionServesHarnessApi,
  harnessRunsOnConnection,
  harnessTakesOrgKeys,
  harnessWireApi,
} from "../harness-connection-api";

const PROVIDER_KEYS = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "azure",
  "bedrock",
  "custom:litellm",
  "",
  "toString",
];

describe("orgKeys", () => {
  it("lets only the qualified harnesses run on an organization connection", () => {
    expect(
      Object.fromEntries(
        HARNESS_IDS.map((id) => [id, HARNESS_DESCRIPTORS[id].orgKeys]),
      ),
    ).toEqual({
      "claude-code": true,
      codex: true,
      "copilot-cli": true,
      cursor: false,
      opencode: false,
    });
  });

  it("reads the descriptor and refuses unknown ids", () => {
    for (const id of HARNESS_IDS) {
      expect(harnessTakesOrgKeys(id)).toBe(HARNESS_DESCRIPTORS[id].orgKeys);
    }
    expect(harnessTakesOrgKeys("toString")).toBe(false);
    expect(harnessTakesOrgKeys("not-a-harness")).toBe(false);
  });
});

describe("harnessWireApi", () => {
  it("names the API each harness speaks, from its protocol", () => {
    expect(
      Object.fromEntries(HARNESS_IDS.map((id) => [id, harnessWireApi(id)])),
    ).toEqual({
      "claude-code": "anthropicMessages",
      codex: "responses",
      "copilot-cli": "responses",
      cursor: null,
      opencode: "anthropicMessages",
    });
    expect(harnessWireApi("constructor")).toBeNull();
    expect(harnessWireApi("not-a-harness")).toBeNull();
  });
});

describe("connectionServesHarnessApi", () => {
  it("answers from the provider key alone", () => {
    expect(
      connectionServesHarnessApi(
        { providerKey: "anthropic" },
        "anthropicMessages",
      ),
    ).toBe(true);
    expect(
      connectionServesHarnessApi({ providerKey: "anthropic" }, "responses"),
    ).toBe(false);
    expect(
      connectionServesHarnessApi({ providerKey: "openai" }, "responses"),
    ).toBe(true);
    expect(
      connectionServesHarnessApi(
        { providerKey: "openai" },
        "anthropicMessages",
      ),
    ).toBe(false);
  });

  it("serves nothing from any other provider, and nothing for no API", () => {
    for (const providerKey of PROVIDER_KEYS) {
      expect(connectionServesHarnessApi({ providerKey }, null)).toBe(false);
      if (providerKey === "anthropic" || providerKey === "openai") continue;
      expect(
        connectionServesHarnessApi({ providerKey }, "anthropicMessages"),
      ).toBe(false);
      expect(connectionServesHarnessApi({ providerKey }, "responses")).toBe(
        false,
      );
    }
  });
});

describe("harnessRunsOnConnection", () => {
  it.each(HARNESS_IDS)(
    "%s runs on exactly the connections its native org upstream names",
    (id) => {
      const nativeProvider = HARNESS_DESCRIPTORS[id].orgUpstream?.provider;
      for (const providerKey of PROVIDER_KEYS) {
        expect(harnessRunsOnConnection(id, { providerKey }), providerKey).toBe(
          providerKey === nativeProvider,
        );
      }
    },
  );

  it("needs a connection and a known harness", () => {
    expect(harnessRunsOnConnection("claude-code", undefined)).toBe(false);
    expect(
      harnessRunsOnConnection("not-a-harness", { providerKey: "anthropic" }),
    ).toBe(false);
  });

  it("refuses OpenCode on Anthropic although it speaks Anthropic Messages", () => {
    expect(harnessWireApi("opencode")).toBe("anthropicMessages");
    expect(
      harnessRunsOnConnection("opencode", { providerKey: "anthropic" }),
    ).toBe(false);
  });
});
