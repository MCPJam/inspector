import { describe, expect, it } from "vitest";
import { HARNESS_IDS } from "@mcpjam/sdk/host-config/internal";
import type { HostDetail } from "@/hooks/useClients";
import type { ModelDefinition } from "@/shared/types";
import { resolvePlaygroundClientColumn } from "../playground-client-columns";
import { harnessPickerModels } from "../harness-model-locks";
import { HARNESS_DESCRIPTORS } from "@/shared/harness-descriptors";

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
    paneId: client.hostId,
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

  it("keeps a disabled saved model on the unavailable result", () => {
    const locked = { ...hosted, disabled: true, disabledReason: "Sign in to use this frontier model" };
    expect(resolve(host, [locked])).toMatchObject({
      status: "unavailable",
      model: locked,
    });
  });

  it("keys a column by its pane, so two panes on one client stay apart", () => {
    const panes = ["a", "a~2"].map((paneId) =>
      resolvePlaygroundClientColumn({
        paneId,
        hostId: host.hostId,
        slot: { host, isLoading: false },
        hosts: [],
        models: [hosted],
      }),
    );
    expect(panes).toMatchObject([
      { status: "ready", column: { compareId: "a", hostId: "a" } },
      { status: "ready", column: { compareId: "a~2", hostId: "a" } },
    ]);
    expect(
      resolvePlaygroundClientColumn({
        paneId: "a~2",
        hostId: "a",
        slot: { host: null, isLoading: true },
        hosts: [],
        models: [hosted],
      }),
    ).toMatchObject({ status: "loading", compareId: "a~2", hostId: "a" });
  });

  it("reports loading, missing and invalid clients explicitly", () => {
    const args = {
      paneId: "a",
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

describe("each column reads the catalog through its own harness", () => {
  // MCPJam-provided rows across vendors: what the authorized catalog holds
  // before any client's harness filter.
  const catalog: ModelDefinition[] = [
    "anthropic/claude-haiku-4.5",
    "anthropic/claude-sonnet-4.5",
    "openai/gpt-5.5",
    "openai/gpt-5-mini",
    "openai/gpt-5.6-luna",
    "google/gemini-2.5-pro",
  ].map((id) => ({
    id,
    name: id,
    provider: id.split("/")[0] as ModelDefinition["provider"],
    hosted: true,
  }));
  const clientOn = (
    harness: { harness?: string; agentLoop?: string },
    modelId: string,
  ): HostDetail => ({
    hostId: `client-${harness.agentLoop ?? harness.harness}`,
    name: "Client",
    config: { ...config, modelId, ...harness } as HostDetail["config"],
  });

  for (const harnessId of HARNESS_IDS) {
    it(`${harnessId}: resolves its saved model on its own list, not the lead's`, () => {
      if (HARNESS_DESCRIPTORS[harnessId].modelAccess === "external-account") {
        // Its account picks the model: the sentinel is what runs.
        const auto = resolve(clientOn({ harness: harnessId }, "cursor/auto"), catalog);
        expect(auto).toMatchObject({
          status: "ready",
          column: { compareSubLabel: "Cursor Auto", model: { id: "cursor/auto" } },
        });
        // A stale ordinary model is a broken setup the server refuses, never
        // a ready column showing a model the account doesn't run. The picker
        // falls back to the whole catalog for this harness, so it would find
        // every row.
        for (const row of catalog) {
          expect(
            resolve(clientOn({ harness: harnessId }, String(row.id)), catalog),
          ).toMatchObject({
            status: "invalid",
            reason: "The saved model choice is invalid. Edit this client in Connect.",
          });
        }
        return;
      }
      const admitted = harnessPickerModels(catalog, { harnessId }).filter(
        (row) => !row.disabled,
      );
      const refused = catalog.filter(
        (row) => !admitted.some((kept) => kept.id === row.id),
      );
      for (const row of admitted) {
        expect(
          resolve(clientOn({ harness: harnessId }, String(row.id)), catalog),
        ).toMatchObject({ status: "ready", column: { model: { id: row.id } } });
      }
      for (const row of refused) {
        expect(
          resolve(clientOn({ harness: harnessId }, String(row.id)), catalog).status,
        ).toBe("unavailable");
      }
    });
  }

  it("a Codex column keeps its model while a Claude Code client leads", () => {
    // The reported bug: every column used to resolve against the lead's
    // Claude Code list, which has no OpenAI rows.
    const codex = clientOn({ harness: "codex" }, "openai/gpt-5.5");
    const leadList = harnessPickerModels(catalog, { harnessId: "claude-code" });
    expect(resolve(codex, leadList).status).toBe("unavailable");
    expect(resolve(codex, catalog)).toMatchObject({
      status: "ready",
      column: { model: { id: "openai/gpt-5.5" } },
    });
  });

  it("reads the agent loop before the harness", () => {
    const viaLoop = clientOn({ agentLoop: "codex" }, "openai/gpt-5.5");
    expect(resolve(viaLoop, catalog)).toMatchObject({ status: "ready" });
    const refusedOnLoop = clientOn({ agentLoop: "codex" }, "anthropic/claude-haiku-4.5");
    expect(resolve(refusedOnLoop, catalog).status).toBe("unavailable");
  });

  it("runs a pane's picked model instead of the client's saved one", () => {
    const codex = clientOn({ harness: "codex" }, "openai/gpt-5.5");
    const pickedSelection = {
      source: "hosted" as const,
      modelId: "openai/gpt-5-mini",
      fallback: { provider: "none" as const, model: "none" as const },
    };
    const picked = resolvePlaygroundClientColumn({
      paneId: "pane",
      hostId: codex.hostId,
      slot: { host: codex, isLoading: false },
      hosts: [],
      models: catalog,
      pickedSelection,
    });
    expect(picked).toMatchObject({
      status: "ready",
      column: {
        model: { id: "openai/gpt-5-mini" },
        selection: pickedSelection,
        modelPicked: true,
      },
    });
    // A pick the pane's harness can't run blocks the pane, with its rows
    // kept so pane settings can choose another.
    const refused = resolvePlaygroundClientColumn({
      paneId: "pane",
      hostId: codex.hostId,
      slot: { host: codex, isLoading: false },
      hosts: [],
      models: catalog,
      pickedSelection: {
        ...pickedSelection,
        modelId: "anthropic/claude-haiku-4.5",
      },
    });
    expect(refused).toMatchObject({
      status: "unavailable",
      reason:
        "This pane's model is unavailable. Choose another in pane settings.",
      hostConfig: codex.config,
    });
    expect(
      refused.status !== "ready" && refused.modelRows?.length,
    ).toBeGreaterThan(0);
  });

  it("ignores a pick on a client whose account chooses the model", () => {
    const cursor = clientOn({ harness: "cursor" }, "cursor/auto");
    expect(
      resolvePlaygroundClientColumn({
        paneId: "pane",
        hostId: cursor.hostId,
        slot: { host: cursor, isLoading: false },
        hosts: [],
        models: catalog,
        pickedSelection: {
          source: "hosted",
          modelId: "openai/gpt-5.5",
          fallback: { provider: "none", model: "none" },
        },
      }),
    ).toMatchObject({
      status: "ready",
      column: {
        model: { id: "cursor/auto" },
        modelPicked: false,
        modelRows: [],
      },
    });
  });

  it("an emulated client resolves against the whole catalog", () => {
    for (const row of catalog) {
      expect(resolve(clientOn({}, String(row.id)), catalog)).toMatchObject({
        status: "ready",
        column: { model: { id: row.id } },
      });
    }
  });
});
