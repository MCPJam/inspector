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
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import { UpdateHostToLatestButton } from "../UpdateHostToLatestButton";
import { toast } from "@/lib/toast";

const liveCatalog = bundledHostCompatCatalog();

vi.mock("@/lib/host-compat/use-host-catalog", async () => {
  const sdk = await vi.importActual<typeof import("@mcpjam/sdk/host-compat")>(
    "@mcpjam/sdk/host-compat"
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
  themeMode: "light" | "dark" = "light"
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
  savedName?: string;
  strictMode?: boolean;
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

  function Harness() {
    const [draft, setDraft] = useState(args.initialDraft);
    const [name, setName] = useState(nameRef.current);
    setDraftRef.current = setDraft;
    draftRef.current = draft;
    nameRef.current = name;
    return (
      <UpdateHostToLatestButton
        hostId="host-test"
        draft={draft}
        savedDraft={args.savedDraft}
        hostDisplayName={name}
        savedHostDisplayName={args.savedName}
        onHostDisplayNameChange={(next) => {
          nameRef.current = next;
          setName(next);
        }}
        themeMode="light"
        onDraftChange={(updater) =>
          setDraft((prev) => {
            const next = updater(prev);
            draftRef.current = next;
            return next;
          })
        }
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
    )
  );
  return {
    draftRef,
    nameRef,
    setDraft: (next: HostConfigInputV2) => setDraftRef.current(next),
    ...utils,
  };
}

describe("UpdateHostToLatestButton", () => {
  it("offers the latest client configuration in a toast", async () => {
    const initial = emptyHostConfigInputV2({
      hostStyle: "mistral",
      modelId: "old-model",
    });
    const { draftRef, nameRef } = renderButton({
      initialDraft: initial,
      initialName: "Old Mistral",
    });

    await waitFor(() => expect(toast.info).toHaveBeenCalledTimes(1));
    const [, options] = vi.mocked(toast.info).mock.calls[0];
    expect(options?.action).toMatchObject({ label: "Update to latest" });

    const action = options?.action as { onClick: () => void };
    act(() => action.onClick());

    expect(draftRef.current).toEqual(catalogDraftFor("mistral"));
    expect(nameRef.current).toBe(catalogLabelFor("mistral"));
    expect(toast.success).toHaveBeenCalledWith("Updated to latest");
  });

  it("keeps the update toast visible during Strict Mode effect replay", async () => {
    const { unmount } = renderButton({
      initialDraft: emptyHostConfigInputV2({
        hostStyle: "mistral",
        modelId: "old-model",
      }),
      initialName: "Old Mistral",
      strictMode: true,
    });

    await waitFor(() => expect(toast.info).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(toast.dismiss).not.toHaveBeenCalled();

    unmount();
    await waitFor(() => expect(toast.dismiss).toHaveBeenCalledTimes(1));
  });

  it("does not treat unsaved local edits as a new client update", () => {
    const savedDraft = catalogDraftFor("claude");
    renderButton({
      initialDraft: { ...savedDraft, modelId: "local-edit" },
      savedDraft,
      initialName: catalogLabelFor("claude"),
      savedName: catalogLabelFor("claude"),
    });

    expect(toast.info).not.toHaveBeenCalled();
  });

  it("checks saved freshness against the saved host style", () => {
    const savedDraft = catalogDraftFor("claude");
    renderButton({
      initialDraft: { ...savedDraft, hostStyle: "mistral" },
      savedDraft,
      initialName: catalogLabelFor("claude"),
      savedName: catalogLabelFor("claude"),
    });

    expect(toast.info).not.toHaveBeenCalled();
  });

  it("does not offer an update while the host style has an unsaved change", () => {
    const savedDraft = emptyHostConfigInputV2({
      hostStyle: "mistral",
      modelId: "old-model",
    });
    renderButton({
      initialDraft: { ...savedDraft, hostStyle: "claude" },
      savedDraft,
      initialName: "Old Mistral",
      savedName: "Old Mistral",
    });

    expect(toast.info).not.toHaveBeenCalled();
  });

  it("does not offer the same catalog update again after local edits", async () => {
    const savedDraft = emptyHostConfigInputV2({
      hostStyle: "mistral",
      modelId: "old-model",
    });
    const { draftRef, setDraft } = renderButton({
      initialDraft: savedDraft,
      savedDraft,
      initialName: "Old Mistral",
      savedName: "Old Mistral",
    });

    await waitFor(() => expect(toast.info).toHaveBeenCalledTimes(1));
    const [, options] = vi.mocked(toast.info).mock.calls[0];
    const action = options?.action as { onClick: () => void };
    act(() => action.onClick());
    act(() => setDraft({ ...draftRef.current, modelId: "local-edit" }));

    expect(toast.info).toHaveBeenCalledTimes(1);
  });

  it("copies the latest catalog template, including image settings", async () => {
    const user = userEvent.setup();
    const serverConnectionOverrides = {
      "srv-1": {
        requestTimeoutOverride: 1234,
      },
    };
    const initial = emptyHostConfigInputV2({
      hostStyle: "mistral",
      modelId: "wrong-model",
      systemPrompt: "local edit",
      temperature: 0.1,
      requireToolApproval: true,
      respectToolVisibility: false,
      progressiveToolDiscovery: true,
      clientCapabilities: {},
      hostContext: { wrong: true, theme: "light" },
      chatUiOverride: { logo: { kind: "dots", color: "#ff0000", count: 1 } },
      hostCapabilitiesOverride: { openLinks: {} },
      modelVisibleMcpToolResults: {
        directContent: { image: true },
        embeddedResources: { blob: { image: true } },
        linkedResources: { blob: { image: true } },
      },
      mcpToolResultImageRendering: {
        placement: "inline",
        directContent: { image: true },
        embeddedResources: { blob: { image: true } },
        linkedResources: { blob: { image: true } },
      },
      serverIds: ["srv-1"],
      optionalServerIds: ["srv-2"],
      serverConnectionOverrides,
      mcpProfile: {
        profileVersion: 1,
        mcpProtocolVersion: "2025-06-18",
        apps: {
          uiInitialize: { hostInfo: { name: "Custom Host" } },
          mcpAppsOverrides: { serverTools: false },
        },
      },
    });
    const { draftRef, nameRef } = renderButton({
      initialDraft: initial,
      initialName: "Custom Mistral",
    });

    await user.click(
      screen.getByRole("button", {
        name: /update to latest/i,
      })
    );

    const expected = catalogDraftFor("mistral");
    expect(draftRef.current).toEqual({
      ...expected,
      hostContext: {
        ...expected.hostContext,
        theme: "light",
      },
      serverIds: ["srv-1"],
      optionalServerIds: ["srv-2"],
      serverConnectionOverrides,
    });
    expect(nameRef.current).toBe(catalogLabelFor("mistral"));
    expect(draftRef.current.modelVisibleMcpToolResults).toEqual(
      expected.modelVisibleMcpToolResults
    );
    expect(draftRef.current.mcpToolResultImageRendering).toEqual(
      expected.mcpToolResultImageRendering
    );
  });

  it("works for non-market templates", async () => {
    const user = userEvent.setup();
    const { draftRef } = renderButton({
      initialDraft: emptyHostConfigInputV2({
        hostStyle: "mcpjam",
        mcpProfile: {
          profileVersion: 1,
          apps: { mcpAppsOverrides: { serverTools: false } },
        },
      }),
    });

    await user.click(
      screen.getByRole("button", {
        name: /update to latest/i,
      })
    );

    expect(draftRef.current).toEqual(catalogDraftFor("mcpjam"));
    expect(draftRef.current.clientCapabilities.elicitation).toEqual({
      form: {},
      url: {},
    });
  });

  it("stays enabled when only the display name needs updating", async () => {
    const user = userEvent.setup();
    const { draftRef } = renderButton({
      initialDraft: catalogDraftFor("slack"),
      initialName: "Slack",
    });

    const button = screen.getByRole("button", {
      name: /update to latest/i,
    });
    expect(button).toBeEnabled();

    await user.click(button);

    expect(draftRef.current).toEqual(catalogDraftFor("slack"));
  });

  it("disables when the draft already matches the catalog", () => {
    const initialDraft = catalogDraftFor("claude");
    renderButton({
      initialDraft,
      initialName: catalogLabelFor("claude"),
    });

    expect(
      screen.getByRole("button", {
        name: /update to latest/i,
      })
    ).toBeDisabled();
  });

  it("sets host theme to the current global theme instead of the catalog theme", async () => {
    const user = userEvent.setup();
    const initialDraft = emptyHostConfigInputV2({
      hostStyle: "claude",
      hostContext: { theme: "dark" },
      modelId: "wrong-model",
    });
    const { draftRef } = renderButton({
      initialDraft,
      initialName: catalogLabelFor("claude"),
    });

    await user.click(
      screen.getByRole("button", {
        name: /update to latest/i,
      })
    );

    expect(draftRef.current.hostContext.theme).toBe("light");
    expect(draftRef.current.modelId).toBe(catalogDraftFor("claude").modelId);
  });
});
