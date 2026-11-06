import { act, StrictMode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  bundledHostCompatCatalog,
  getCatalogHost,
  getCatalogTemplate,
} from "@mcpjam/sdk/host-compat";
import {
  cloneHostTemplateInput,
  hostConfigInputsEqual,
  hostConfigDtoToInput,
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import { canonicalizeHostConfigV2 } from "@mcpjam/sdk/host-config/internal";
import { addHostTemplateDefaults } from "../host-template-defaults";
import { UpdateHostToLatestButton } from "../UpdateHostToLatestButton";
import { toast } from "@/lib/toast";

const liveCatalog = bundledHostCompatCatalog();

vi.mock("@/lib/host-compat/use-host-catalog", async () => {
  const sdk = await vi.importActual<typeof import("@mcpjam/sdk/host-compat")>(
    "@mcpjam/sdk/host-compat",
  );
  return {
    useHostCatalog: () => ({
      status: "live",
      catalog: sdk.bundledHostCompatCatalog(),
      version: 1,
      source: "live",
    }),
  };
});

vi.mock("@/lib/toast", () => ({
  toast: { dismiss: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function catalogDraftFor(
  hostStyle: string,
  themeMode: "light" | "dark" = "light",
) {
  const template = getCatalogTemplate(liveCatalog, hostStyle);
  if (!template) throw new Error(`Missing template for ${hostStyle}`);
  return cloneHostTemplateInput(template, { themeMode });
}

function catalogLabelFor(hostStyle: string) {
  const host = getCatalogHost(liveCatalog, hostStyle);
  if (!host) throw new Error(`Missing catalog host for ${hostStyle}`);
  return host.label;
}

function renderButton(args: {
  initialDraft: HostConfigInputV2;
  initialName?: string;
  savedDraft?: HostConfigInputV2;
  strictMode?: boolean;
  onSaveLatest?: (name: string, draft: HostConfigInputV2) => Promise<boolean>;
  hostLoaded?: boolean;
  saveInFlight?: boolean;
}) {
  const draftRef: { current: HostConfigInputV2 } = {
    current: args.initialDraft,
  };
  const nameRef: { current: string } = {
    current: args.initialName ?? "Custom Host",
  };
  const setDraftRef: {
    current: (next: HostConfigInputV2) => void;
  } = { current: () => undefined };
  const onSaveLatest = args.onSaveLatest ?? vi.fn().mockResolvedValue(true);

  function Harness() {
    const [draft, setDraft] = useState(args.initialDraft);
    const [name] = useState(nameRef.current);
    setDraftRef.current = setDraft;
    draftRef.current = draft;
    nameRef.current = name;
    return (
      <UpdateHostToLatestButton
        hostId="host-test"
        draft={draft}
        savedDraft={args.savedDraft}
        hostDisplayName={name}
        onDraftChange={(updater) =>
          setDraft((prev) => {
            const next = updater(prev);
            draftRef.current = next;
            return next;
          })
        }
        onSaveLatest={onSaveLatest}
        hostLoaded={args.hostLoaded ?? true}
        saveInFlight={args.saveInFlight ?? false}
      />
    );
  }

  const utils = render(
    args.strictMode ? (
      <StrictMode>
        <Harness />
      </StrictMode>
    ) : (
      <Harness />
    ),
  );
  return {
    draftRef,
    nameRef,
    onSaveLatest,
    setDraft: (next: HostConfigInputV2) => setDraftRef.current(next),
    ...utils,
  };
}

describe("UpdateHostToLatestButton", () => {
  it("does not offer an update for a custom name or agent resources alone", () => {
    const current = {
      ...catalogDraftFor("chatgpt"),
      modelId: "custom-model",
      systemPrompt: "Keep my instructions",
      temperature: 0.2,
      computer: { kind: "personal" as const, workdir: "/workspace/qa" },
      builtInToolIds: ["bash"],
      serverIds: ["server-qa"],
    };
    renderButton({
      initialDraft: current,
      initialName: "Defaults Baseline QA",
    });
    expect(toast.info).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /update to latest/i }),
    ).toBeDisabled();
  });

  it("adds an absent preset default while preserving explicit choices", async () => {
    const latest = catalogDraftFor("chatgpt");
    expect(
      latest.mcpProfile?.apps?.pluginExtensions?.capabilities?.mentions,
    ).toBe(true);
    const initial: HostConfigInputV2 = {
      ...latest,
      modelId: "custom-model",
      systemPrompt: "Keep my instructions",
      temperature: 0.2,
      computer: { kind: "personal", workdir: "/workspace/qa" },
      builtInToolIds: ["bash"],
      serverIds: ["server-qa"],
      serverConnectionOverrides: {
        "server-qa": { requestTimeoutOverride: 4321 },
      },
      mcpProfile: {
        ...latest.mcpProfile,
        profileVersion: 1,
        apps: {
          ...latest.mcpProfile?.apps,
          mcpAppsOverrides: {
            serverTools: false,
            availableDisplayModes: ["inline"],
          },
          pluginExtensions: { enabled: true, capabilities: { forms: false } },
        },
      },
    };
    const expected: HostConfigInputV2 = {
      ...initial,
      mcpProfile: {
        ...initial.mcpProfile,
        profileVersion: 1,
        apps: {
          ...initial.mcpProfile?.apps,
          mcpAppsOverrides: {
            ...latest.mcpProfile?.apps?.mcpAppsOverrides,
            serverTools: false,
            availableDisplayModes: ["inline"],
          },
          pluginExtensions: {
            ...latest.mcpProfile?.apps?.pluginExtensions,
            enabled: true,
            capabilities: {
              ...latest.mcpProfile?.apps?.pluginExtensions?.capabilities,
              forms: false,
            },
          },
        },
      },
    };
    const untouched = structuredClone(initial);
    const ui = renderButton({
      initialDraft: initial,
      initialName: "My QA client",
    });
    expect(ui.onSaveLatest).not.toHaveBeenCalled();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /update to latest/i }));
    expect(ui.draftRef.current).toEqual(expected);
    expect(ui.nameRef.current).toBe("My QA client");
    expect(ui.onSaveLatest).toHaveBeenCalledExactlyOnceWith(
      "My QA client",
      expected,
    );
    expect(initial).toEqual(untouched);
    expect(
      screen.getByRole("button", { name: /update to latest/i }),
    ).toBeDisabled();
  });

  it("does not overwrite an explicit false with a newer true default", () => {
    const latest = catalogDraftFor("chatgpt");
    const initial: HostConfigInputV2 = {
      ...latest,
      mcpProfile: {
        ...latest.mcpProfile,
        profileVersion: 1,
        apps: {
          ...latest.mcpProfile?.apps,
          pluginExtensions: {
            ...latest.mcpProfile?.apps?.pluginExtensions,
            enabled: true,
            capabilities: {
              ...latest.mcpProfile?.apps?.pluginExtensions?.capabilities,
              mentions: false,
            },
          },
        },
      },
    };
    renderButton({ initialDraft: initial });
    expect(toast.info).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /update to latest/i }),
    ).toBeDisabled();
  });

  it("preserves the current model selection and a deliberately detached computer", async () => {
    const latest = catalogDraftFor("chatgpt");
    const initial: HostConfigInputV2 = {
      ...latest,
      modelId: "openai/gpt-5.6-luna",
      modelSelection: {
        modelId: "openai/gpt-5.6-luna",
        source: "org",
        connectionRef: { kind: "orgProvider", id: "orgprov_qa" },
        nativeModelId: "gpt-5.6-luna",
        fallback: { provider: "none", model: "none" },
      },
      computer: undefined,
      harness: undefined,
      agentLoop: "codex",
      browserProfileId: "browser-qa",
      mcpProfile: undefined,
    };
    const ui = renderButton({ initialDraft: initial, initialName: "Org QA" });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /update to latest/i }));
    expect(ui.draftRef.current.modelSelection).toEqual(initial.modelSelection);
    expect(ui.draftRef.current.computer).toBeUndefined();
    expect(ui.draftRef.current.harness).toBeUndefined();
    expect(ui.draftRef.current.agentLoop).toBe("codex");
    expect(ui.draftRef.current.browserProfileId).toBe("browser-qa");
    expect(ui.onSaveLatest).toHaveBeenCalledOnce();
  });

  it("keeps explicit capability payloads and false values while adding other defaults", async () => {
    const latest = catalogDraftFor("chatgpt");
    const initial: HostConfigInputV2 = {
      ...latest,
      clientCapabilities: { experimental: {}, custom: [] },
      hostCapabilitiesOverride: { serverTools: false },
      mcpProfile: {
        profileVersion: 1,
        apps: {
          pluginExtensions: {
            enabled: false,
            capabilities: { mentions: false },
          },
          mcpAppsOverrides: {
            availableDisplayModes: ["inline"],
            toolResult: { content: { image: false } },
          },
        },
      },
    };
    const ui = renderButton({ initialDraft: initial });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /update to latest/i }));
    expect(ui.draftRef.current.clientCapabilities).toMatchObject({
      experimental: {},
      custom: [],
    });
    expect(ui.draftRef.current.hostCapabilitiesOverride).toEqual({
      serverTools: false,
    });
    expect(
      ui.draftRef.current.mcpProfile?.apps?.pluginExtensions,
    ).toMatchObject({ enabled: false, capabilities: { mentions: false } });
    expect(
      ui.draftRef.current.mcpProfile?.apps?.mcpAppsOverrides,
    ).toMatchObject({
      availableDisplayModes: ["inline"],
      toolResult: { content: { image: false } },
    });
  });

  it("keeps an unsuccessful update as an unsaved draft and does not report success", async () => {
    const initial = { ...catalogDraftFor("chatgpt"), mcpProfile: undefined };
    const onSaveLatest = vi.fn().mockResolvedValue(false);
    const ui = renderButton({ initialDraft: initial, onSaveLatest });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /update to latest/i }));
    expect(onSaveLatest).toHaveBeenCalledOnce();
    expect(
      ui.draftRef.current.mcpProfile?.apps?.pluginExtensions?.capabilities
        ?.mentions,
    ).toBe(true);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("offers the same missing defaults only once across Strict Mode and local edits", async () => {
    const initial = { ...catalogDraftFor("chatgpt"), mcpProfile: undefined };
    const ui = renderButton({
      initialDraft: initial,
      savedDraft: initial,
      strictMode: true,
    });
    await waitFor(() => expect(toast.info).toHaveBeenCalledTimes(1));
    const [, options] = vi.mocked(toast.info).mock.calls[0];
    expect(options?.description).toContain("keep your saved settings");
    await act(async () => options?.action?.onClick());
    act(() =>
      ui.setDraft({ ...ui.draftRef.current, modelId: "changed-model" }),
    );
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(ui.onSaveLatest).toHaveBeenCalledOnce();
  });

  it("does not offer an update for unsaved host style changes", () => {
    const saved = catalogDraftFor("chatgpt");
    renderButton({
      initialDraft: { ...saved, hostStyle: "mistral" },
      savedDraft: saved,
    });
    expect(toast.info).not.toHaveBeenCalled();
  });

  it.each([{ hostLoaded: false }, { saveInFlight: true }])(
    "waits for the host and saves already in flight: %j",
    (state) => {
      renderButton({
        initialDraft: { ...catalogDraftFor("chatgpt"), mcpProfile: undefined },
        ...state,
      });
      expect(
        screen.getByRole("button", { name: /update to latest/i }),
      ).toBeDisabled();
    },
  );

  it("converges after the actual saved configuration canonicalizer", () => {
    const latest = catalogDraftFor("chatgpt");
    const sparse: HostConfigInputV2 = {
      ...latest,
      mcpProfile: {
        ...latest.mcpProfile,
        profileVersion: 1,
        apps: {
          ...latest.mcpProfile?.apps,
          pluginExtensions: {
            enabled: true,
            capabilities: {
              fileResources: false,
              fileViewers: false,
              localFiles: false,
              forms: false,
            },
          },
        },
      },
    };
    const first = addHostTemplateDefaults(latest, sparse);
    const saved = hostConfigDtoToInput({
      ...cloneHostTemplateInput(canonicalizeHostConfigV2(first)),
      id: "saved-config",
      schemaVersion: 2,
    });
    const second = addHostTemplateDefaults(latest, saved);
    expect(second).toEqual(saved);
    expect(hostConfigInputsEqual(saved, second)).toBe(true);
  });
});
