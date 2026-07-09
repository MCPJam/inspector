import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  bundledHostCompatCatalog,
  getCatalogHost,
  getCatalogTemplate,
} from "@mcpjam/sdk/host-compat";
import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import { UpdateCapabilitiesButton } from "../UpdateCapabilitiesButton";

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
  toast: { success: vi.fn() },
}));

function cloneTemplate(hostStyle: string): HostConfigInputV2 {
  const template = getCatalogTemplate(liveCatalog, hostStyle);
  if (!template) throw new Error(`Missing template for ${hostStyle}`);
  return JSON.parse(JSON.stringify(template)) as HostConfigInputV2;
}

function catalogLabel(hostStyle: string): string {
  const host = getCatalogHost(liveCatalog, hostStyle);
  if (!host) throw new Error(`Missing catalog host for ${hostStyle}`);
  return host.label;
}

function renderButton(args: {
  initialDraft: HostConfigInputV2;
  initialName: string;
}) {
  const draftRef: { current: HostConfigInputV2 } = {
    current: args.initialDraft,
  };
  const nameRef: { current: string } = { current: args.initialName };

  function Harness() {
    const [draft, setDraft] = useState(args.initialDraft);
    const [name, setName] = useState(args.initialName);
    draftRef.current = draft;
    nameRef.current = name;
    return (
      <UpdateCapabilitiesButton
        hostDisplayName={name}
        onHostDisplayNameChange={(next) => {
          nameRef.current = next;
          setName(next);
        }}
        draft={draft}
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

  const utils = render(<Harness />);
  return { draftRef, nameRef, ...utils };
}

describe("UpdateCapabilitiesButton", () => {
  it("replaces the draft with the full latest catalog template", async () => {
    const user = userEvent.setup();
    const initial = emptyHostConfigInputV2({
      hostStyle: "claude",
      modelId: "wrong-model",
      systemPrompt: "local edit",
      temperature: 0.1,
      requireToolApproval: true,
      respectToolVisibility: false,
      progressiveToolDiscovery: true,
      clientCapabilities: {},
      hostContext: { wrong: true },
      chatUiOverride: { logo: { kind: "dots", color: "#ff0000", count: 1 } },
      modelVisibleMcpToolResults: {
        directContent: { image: false },
      },
      mcpToolResultImageRendering: {
        placement: "none",
      },
    });
    const { draftRef } = renderButton({
      initialDraft: initial,
      initialName: "Custom Claude",
    });

    await user.click(
      screen.getByRole("button", {
        name: /update to latest/i,
      })
    );

    expect(draftRef.current).toEqual(cloneTemplate("claude"));
    expect(draftRef.current.modelVisibleMcpToolResults).toEqual({
      directContent: { image: true },
      embeddedResources: { blob: { image: true } },
      linkedResources: { blob: { image: false } },
    });
    expect(draftRef.current.mcpToolResultImageRendering).toEqual({
      placement: "inline",
      directContent: { image: true },
      embeddedResources: { blob: { image: true } },
      linkedResources: { blob: { image: false } },
    });
  });

  it("updates the host display name from the catalog label", async () => {
    const user = userEvent.setup();
    const { nameRef } = renderButton({
      initialDraft: emptyHostConfigInputV2({ hostStyle: "slack" }),
      initialName: "Slackbot",
    });

    await user.click(
      screen.getByRole("button", {
        name: /update to latest/i,
      })
    );

    expect(nameRef.current).toBe(catalogLabel("slack"));
  });

  it("works for non-market templates", async () => {
    const user = userEvent.setup();
    const { draftRef, nameRef } = renderButton({
      initialDraft: emptyHostConfigInputV2({
        hostStyle: "mcpjam",
        modelId: "wrong-model",
      }),
      initialName: "Wrong MCPJam",
    });

    await user.click(
      screen.getByRole("button", {
        name: /update to latest/i,
      })
    );

    expect(draftRef.current).toEqual(cloneTemplate("mcpjam"));
    expect(nameRef.current).toBe(catalogLabel("mcpjam"));
  });

  it("stays enabled when only the display name is stale", async () => {
    const user = userEvent.setup();
    const { nameRef } = renderButton({
      initialDraft: cloneTemplate("slack"),
      initialName: "Definitely stale name",
    });

    const button = screen.getByRole("button", {
      name: /update to latest/i,
    });
    expect(button).toBeEnabled();

    await user.click(button);

    expect(nameRef.current).toBe(catalogLabel("slack"));
  });

  it("disables when the draft and display name already match the catalog", () => {
    renderButton({
      initialDraft: cloneTemplate("claude"),
      initialName: catalogLabel("claude"),
    });

    expect(
      screen.getByRole("button", {
        name: /update to latest/i,
      })
    ).toBeDisabled();
  });
});
