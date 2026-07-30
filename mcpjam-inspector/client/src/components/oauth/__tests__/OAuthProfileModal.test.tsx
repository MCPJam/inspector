import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OAuthProfileModal } from "../OAuthProfileModal";
import type { ServerWithName } from "@/hooks/use-app-state";

function renderModal(
  props?: Partial<React.ComponentProps<typeof OAuthProfileModal>>,
) {
  const onSave = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <OAuthProfileModal
      open
      onOpenChange={onOpenChange}
      existingServerNames={[]}
      onSave={onSave}
      {...props}
    />,
  );
  return { onSave, onOpenChange };
}

function createServer(name: string): ServerWithName {
  return {
    name,
    connectionStatus: "connected",
    enabled: true,
    retryCount: 0,
    useOAuth: true,
    lastConnectionTime: new Date("2024-01-01"),
    config: {
      transportType: "streamableHttp",
      url: "https://existing.example.com/mcp",
    },
  } as ServerWithName;
}

describe("OAuthProfileModal", () => {
  it("rejects a duplicate name when adding a new target", async () => {
    // Add mode passes no `server`, so the hook's rename guard never fires —
    // without the modal's own check this save silently overwrote staging-mcp.
    const user = userEvent.setup();
    const { onSave } = renderModal({ existingServerNames: ["staging-mcp"] });

    await user.clear(screen.getByLabelText(/Server Name/));
    await user.type(screen.getByLabelText(/Server Name/), "staging-mcp");
    await user.type(
      screen.getByLabelText(/Server URL/),
      "https://staging.example.com/mcp",
    );
    await user.click(screen.getByRole("button", { name: "Save configuration" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/already exists/i);
  });

  it("rejects renaming an existing target onto another target's name", async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal({
      server: createServer("oauth-flow-target"),
      existingServerNames: ["oauth-flow-target", "staging-mcp"],
    });

    await user.clear(screen.getByLabelText(/Server Name/));
    await user.type(screen.getByLabelText(/Server Name/), "staging-mcp");
    await user.click(screen.getByRole("button", { name: "Save configuration" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/already exists/i);
  });

  it("preserves leading/trailing whitespace in a saved client secret", async () => {
    // Trimming the secret here would silently corrupt one that legitimately
    // has surrounding whitespace before it's saved or used in the live flow.
    const user = userEvent.setup();
    const { onSave } = renderModal();

    await user.clear(screen.getByLabelText(/Server Name/));
    await user.type(screen.getByLabelText(/Server Name/), "whitespace-secret-target");
    await user.type(
      screen.getByLabelText(/Server URL/),
      "https://oauth.example.com/mcp",
    );
    await user.click(screen.getByText("Advanced settings (optional)"));
    await user.type(
      screen.getByPlaceholderText("Client Secret (optional)"),
      " secret ",
    );
    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        formData: expect.objectContaining({ clientSecret: " secret " }),
        profile: expect.objectContaining({ clientSecret: " secret " }),
      }),
    );
  });

  it("allows saving an existing target under its own unchanged name", async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal({
      server: createServer("oauth-flow-target"),
      existingServerNames: ["oauth-flow-target", "staging-mcp"],
    });

    await user.click(screen.getByRole("button", { name: "Save configuration" }));

    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("carries the selected 2026 OAuth protocol version onto the saved form data", async () => {
    // Without oauthProtocolMode on the saved form data, toMCPConfig cannot
    // stamp the 2026 wire era and hosted chat/eval connects fall back to 2025.
    const user = userEvent.setup();
    const server = createServer("oauth-flow-target");
    (server as any).oauthFlowProfile = {
      serverUrl: "https://existing.example.com/mcp",
      clientId: "",
      clientSecret: "",
      scopes: "",
      customHeaders: [],
      protocolVersion: "2026-07-28",
    };
    const { onSave } = renderModal({
      server,
      existingServerNames: ["oauth-flow-target"],
    });

    await user.click(screen.getByRole("button", { name: "Save configuration" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0][0];
    expect(payload.formData.oauthProtocolMode).toBe("2026-07-28");
    expect(payload.profile.protocolVersion).toBe("2026-07-28");
  });

  it("blocks a second submit while the first save is still in flight", async () => {
    // Awaiting onSave keeps the modal open, which opened a resubmit window the
    // old fire-and-forget close never had.
    const user = userEvent.setup();
    let releaseSave: (() => void) | undefined;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseSave = resolve;
        }),
    );
    render(
      <OAuthProfileModal
        open
        onOpenChange={vi.fn()}
        server={createServer("oauth-flow-target")}
        existingServerNames={["oauth-flow-target"]}
        onSave={onSave}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save configuration" }));
    expect(onSave).toHaveBeenCalledTimes(1);

    // Still saving: the button is disabled, so a second click is a no-op.
    const savingButton = screen.getByRole("button", { name: "Saving…" });
    expect(savingButton).toBeDisabled();
    await user.click(savingButton);
    expect(onSave).toHaveBeenCalledTimes(1);

    releaseSave?.();
  });
});

describe("OAuthProfileModal — agentSeed", () => {
  it("overlays name, URL, and registration mode on open", () => {
    renderModal({
      agentSeed: {
        serverName: "agent-target",
        serverUrl: "https://agent.example.com/mcp",
        registrationStrategy: "preregistered",
      },
    });

    expect(screen.getByLabelText(/Server Name/)).toHaveValue("agent-target");
    expect(screen.getByLabelText(/Server URL/)).toHaveValue(
      "https://agent.example.com/mcp",
    );
    // The Select renders the value text in the trigger and its option list.
    expect(screen.getAllByText("Pre-registered").length).toBeGreaterThan(0);
  });

  it("keeps derived defaults for anything the seed omits", () => {
    renderModal({
      agentSeed: { serverUrl: "https://agent.example.com/mcp" },
    });

    // Default name (no server prop, no seeded name)…
    expect(screen.getByLabelText(/Server Name/)).toHaveValue(
      "oauth-flow-target",
    );
    // …and the fresh-profile default registration strategy.
    expect(screen.getAllByText("Dynamic (DCR)").length).toBeGreaterThan(0);
  });

  it("does not retain a seed across a reopen without one", () => {
    const { rerender } = render(
      <OAuthProfileModal
        open
        onOpenChange={vi.fn()}
        existingServerNames={[]}
        onSave={vi.fn()}
        agentSeed={{ serverName: "agent-target" }}
      />,
    );
    expect(screen.getByLabelText(/Server Name/)).toHaveValue("agent-target");

    // Close, then reopen WITHOUT a seed (the tab clears it on close).
    rerender(
      <OAuthProfileModal
        open={false}
        onOpenChange={vi.fn()}
        existingServerNames={[]}
        onSave={vi.fn()}
        agentSeed={null}
      />,
    );
    rerender(
      <OAuthProfileModal
        open
        onOpenChange={vi.fn()}
        existingServerNames={[]}
        onSave={vi.fn()}
        agentSeed={null}
      />,
    );
    expect(screen.getByLabelText(/Server Name/)).toHaveValue(
      "oauth-flow-target",
    );
  });
});
