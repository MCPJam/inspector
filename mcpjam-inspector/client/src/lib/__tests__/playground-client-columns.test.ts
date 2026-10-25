import { describe, expect, it } from "vitest";
import type { HostDetail } from "@/hooks/useClients";
import type { ModelDefinition } from "@/shared/types";
import { resolvePlaygroundClientColumn } from "../playground-client-columns";

const hosted: ModelDefinition = {
  id: "openai/gpt-5",
  name: "GPT-5",
  provider: "openai",
  hosted: true,
};
const own: ModelDefinition = {
  ...hosted,
  provider: "openrouter",
  hosted: false,
};
const config: HostDetail["config"] = {
  id: "config-a",
  schemaVersion: 2,
  hostStyle: "chatgpt",
  modelId: String(hosted.id),
  systemPrompt: "",
  temperature: 0,
  requireToolApproval: false,
  serverIds: [],
  optionalServerIds: [],
  clientCapabilities: {},
  hostContext: {},
  connectionDefaults: { headers: {}, requestTimeout: 30000 },
};
const host: HostDetail = { hostId: "a", name: "A", config };
function resolve(client = host, models = [hosted, own]) {
  return resolvePlaygroundClientColumn({
    hostId: client.hostId,
    slot: { host: client, isLoading: false },
    hosts: [],
    models,
  });
}

describe("saved-client comparison resolution", () => {
  it("preserves empty, false and zero settings", () => {
    const result = resolve();
    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected a ready client");
    expect(result.column.executionConfig).toEqual({
      systemPrompt: "",
      temperature: 0,
      requireToolApproval: false,
    });
  });

  it("keeps each client's configuration after reorder and a saved edit", () => {
    const a = {
      ...host,
      config: { ...config, systemPrompt: "UPPERCASE" },
    };
    const b = {
      ...host,
      hostId: "b",
      config: { ...config, systemPrompt: "lowercase" },
    };
    const before = [a, b].map((client) => resolve(client));
    expect([b, a].map((client) => resolve(client))).toEqual([
      before[1],
      before[0],
    ]);
    expect(
      resolve({ ...a, config: { ...a.config, systemPrompt: "Changed" } }),
    ).not.toEqual(before[0]);
    expect(resolve(b)).toEqual(before[1]);
  });

  it("does not substitute hosted credits for an unavailable saved connection", () => {
    const client: HostDetail = {
      ...host,
      config: {
        ...config,
        modelSelection: {
          source: "local",
          modelId: config.modelId,
          connectionRef: { kind: "localProvider", providerKey: "openrouter" },
          fallback: { provider: "none", model: "none" },
        },
      },
    };
    expect(resolve(client, [hosted]).status).toBe("unavailable");
    expect(resolve(client)).toMatchObject({
      status: "ready",
      column: { model: own },
    });
  });

  it("reports loading, missing and invalid clients explicitly", () => {
    const args = {
      hostId: "a",
      hosts: [],
      models: [hosted],
    };
    expect(
      resolvePlaygroundClientColumn({
        ...args,
        slot: { host: null, isLoading: true },
      }).status,
    ).toBe("loading");
    expect(
      resolvePlaygroundClientColumn({
        ...args,
        slot: { host: null, isLoading: false },
      }).status,
    ).toBe("unavailable");
    expect(
      resolve({
        ...host,
        config: {
          ...config,
          modelSelection: {
            source: "hosted",
            modelId: "",
            fallback: { provider: "none", model: "none" },
          },
        },
      }).status,
    ).toBe("invalid");
  });
});
