import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { jsonSchema, tool } from "ai";
import { buildSetupManifest, capturePreparedWebSetup } from "../setup-manifest.js";
import type { ResolvedEnvironmentRuntime } from "../../environments/runtime.js";
import { resolveEffectiveCapabilities } from "../../environments/effective-capabilities.js";

const hash = "a".repeat(64);
const environment: ResolvedEnvironmentRuntime = {
  environmentRef: { environmentId: "hidden", name: "", revision: 1 },
  host: { hostId: "host", runtimeConfig: { configHash: hash } },
  selectedSecretIds: [],
  serverConfigHashes: { server: hash },
  servers: { effectiveServerIds: ["server"] },
  skills: [],
  pluginVersions: [],
};
const input = {
  routingRef: "mcpjam-hosted",
  environment,
  capabilities: resolveEffectiveCapabilities(environment, null),
  model: { id: "openai/gpt-5", provider: "openai" },
  engine: "emulated",
  venue: "hosted",
  systemPrompt: "Applied prompt",
  requireToolApproval: false,
  serverIds: ["server"],
  builtInIds: [],
  tools: {
    lookup: tool({
      description: "Lookup",
      inputSchema: jsonSchema({ type: "object" }),
    }),
  },
};
describe("effective setup capture", () => {
  it("uses code-unit ordering for schema keys independently of process locale", async () => {
    const schema = {
      type: "object",
      properties: {
        apple: { type: "string" },
        Zebra: { type: "number" },
        _meta: { type: "boolean" },
      },
    };
    const result = await buildSetupManifest({
      ...input,
      tools: {
        lookup: tool({
          description: "Lookup",
          inputSchema: jsonSchema(schema),
        }),
      },
    });
    const expected =
      '[{"description":"Lookup","inputSchema":{"properties":{"Zebra":{"type":"number"},"_meta":{"type":"boolean"},"apple":{"type":"string"}},"type":"object"},"name":"lookup"}]';
    expect(result.setup?.tools.schemaHash).toBe(
      createHash("sha256").update(expected).digest("hex"),
    );
  });

  it("records the local engine separately from the remote model", async () => {
    const result = await capturePreparedWebSetup({
      prepare: {
        modelDefinition: { id: "openai/gpt-5", name: "GPT-5", provider: "openai", hosted: true },
        selectedServerIds: ["server"],
        uiMessages: [],
        effectiveCapabilities: input.capabilities,
      },
      persist: {
        projectId: "project",
        chatSessionId: "chat",
        sourceType: "direct",
        origin: "playground",
        originalMessages: [],
        selectedServerIds: ["server"],
        setupEnvironment: environment,
      },
      prepared: { resolvedTemperature: 0.7 },
      tools: input.tools,
      maxSteps: 8,
      serverIds: ["server"],
      systemPrompt: "Applied prompt",
      secretsUnavailable: false,
      modelVenue: "remote",
    });
    expect(result.setup?.runtime.venue).toBe("local");
    expect(result.setup?.model).toEqual({
      id: "openai/gpt-5", provider: "openai", routingRef: "mcpjam-hosted",
    });
    expect(result.setup?.settings.policyHash).toBeTruthy();
  });

  it("captures the prepared tool catalog and admitted servers", async () => {
    const result = await buildSetupManifest(input);
    expect(result.status).toBe("complete");
    const refused = await buildSetupManifest({
      ...input,
      serverIds: [],
      tools: {},
    });
    expect(refused.setup).not.toEqual(result.setup);
    expect(JSON.stringify(result)).not.toContain("Applied prompt");
  });
  it("changes with applied settings and marks unknown provenance incomplete", async () => {
    const result = await buildSetupManifest(input);
    expect(
      (await buildSetupManifest({ ...input, reasoningEffort: "high" })).setup,
    ).not.toEqual(result.setup);
    expect(
      await buildSetupManifest({
        ...input,
        incomplete: ["skill_provenance_unavailable"],
      }),
    ).toEqual({
      version: 1,
      status: "incomplete",
      reasons: ["skill_provenance_unavailable"],
    });
    expect(
      (await buildSetupManifest({ ...input, engine: "cursor" })).status,
    ).toBe("incomplete");
  });
  it("normalizes metadata while retaining the effective step limit", async () => {
    const web = await buildSetupManifest({
      ...input,
      maxSteps: 8,
      toolMode: "auto",
      policy: { hostStyle: "claude" },
    });
    const api = await buildSetupManifest({
      ...input,
      maxSteps: 8,
      toolMode: "auto",
    });
    expect(web).toEqual(api);
    expect(
      await buildSetupManifest({ ...input, maxSteps: 9, toolMode: "auto" }),
    ).not.toEqual(api);
  });
  it("distinguishes the effective browser allowlist", async () => {
    const result = await buildSetupManifest(input);
    const changed = await buildSetupManifest({
      ...input,
      executionPolicy: { browser: { allowedDomains: ["example.com"] } },
    });
    expect(changed.setup?.settings.policyHash).not.toEqual(
      result.setup?.settings.policyHash,
    );
  });
  it("distinguishes effective tool-result policies", async () => {
    const result = await buildSetupManifest(input);
    const changed = await buildSetupManifest({
      ...input,
      policy: {
        modelVisibleMcpToolResults: { directContent: { text: false } },
      },
    });
    expect(changed.setup?.settings.policyHash).not.toEqual(
      result.setup?.settings.policyHash,
    );
  });
});
