import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  MCP_PROTOCOL_VERSIONS,
  protocolVersionLabel,
} from "@mcpjam/sdk/browser";
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

  it("marks only the newest known revision as Latest", () => {
    // The dialog used to hardcode "(Draft)" on 2026-07-28 while 2025-11-25 held
    // "(Latest)", telling testers the newer revision was unreleased. Asserted
    // against MCP_PROTOCOL_VERSIONS rather than a pinned string so the next
    // revision fails here instead of re-arming the same bug.
    const latest = MCP_PROTOCOL_VERSIONS[MCP_PROTOCOL_VERSIONS.length - 1];
    renderModal();

    expect(
      screen.getAllByText(protocolVersionLabel(latest)).length,
    ).toBeGreaterThan(0);
    for (const version of MCP_PROTOCOL_VERSIONS) {
      if (version === latest) continue;
      expect(screen.queryByText(`Latest (${version})`)).not.toBeInTheDocument();
    }
    expect(screen.queryByText(/\(Draft\)/)).not.toBeInTheDocument();
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

  it("rejects a pre-registered target saved without a client id", async () => {
    // Pre-registered skips DCR, so an empty client id only failed later, in the
    // flow itself ("Pre-registered client ID is required"). No exemption for a
    // client id stored by an earlier DCR run: the save itself deletes that
    // record, so the flow would still have nothing to use.
    const user = userEvent.setup();
    const { onSave } = renderModal({
      agentSeed: {
        serverUrl: "https://agent.example.com/mcp",
        registrationStrategy: "preregistered",
      },
    });

    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Client ID is required for pre-registered/i,
    );
  });

  it("clears the client-id error once the strategy moves off pre-registered", async () => {
    // The error names switching to DCR as a remedy, so it must not survive the
    // user doing exactly that.
    const user = userEvent.setup();
    renderModal({
      agentSeed: {
        serverUrl: "https://agent.example.com/mcp",
        registrationStrategy: "preregistered",
      },
    });

    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await user.click(screen.getByLabelText(/Registration/));
    await user.click(await screen.findByRole("option", { name: "Dynamic (DCR)" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reveals the collapsed advanced section when pre-registered is in play", async () => {
    // The client id input lives behind "Advanced settings (optional)", so a
    // required field was hidden by a control that calls itself optional.
    renderModal({
      agentSeed: {
        serverUrl: "https://agent.example.com/mcp",
        registrationStrategy: "preregistered",
      },
    });

    expect(screen.getByPlaceholderText("Client ID")).toBeInTheDocument();
  });

  it("saves a pre-registered target once a client id is filled in", async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal({
      agentSeed: {
        serverUrl: "https://agent.example.com/mcp",
        registrationStrategy: "preregistered",
      },
    });

    await user.type(screen.getByPlaceholderText("Client ID"), "client-abc");
    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        formData: expect.objectContaining({ clientId: "client-abc" }),
        profile: expect.objectContaining({
          clientId: "client-abc",
          registrationStrategy: "preregistered",
        }),
      }),
    );
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

  it("collapses the advanced section again on a reopen that does not need it", () => {
    // The modal is never unmounted, so the accordion state outlives a close —
    // without a reset the next (DCR) target opens with Advanced expanded.
    const { rerender } = render(
      <OAuthProfileModal
        open
        onOpenChange={vi.fn()}
        existingServerNames={[]}
        onSave={vi.fn()}
        agentSeed={{
          serverUrl: "https://agent.example.com/mcp",
          registrationStrategy: "preregistered",
        }}
      />,
    );
    expect(screen.getByPlaceholderText("Client ID")).toBeInTheDocument();

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

    expect(screen.queryByPlaceholderText("Client ID")).not.toBeInTheDocument();
  });

  it("keeps user edits when the parent refreshes its server record mid-edit", async () => {
    // `derivedProfile`/`generateDefaultName` change identity whenever the
    // server row ticks (connection status, tokens) or the name list is rebuilt.
    // Reseeding on that churn wipes the open dialog's typed values.
    const user = userEvent.setup();
    const server = createServer("oauth-flow-target");
    const { rerender } = render(
      <OAuthProfileModal
        open
        onOpenChange={vi.fn()}
        server={server}
        existingServerNames={["oauth-flow-target"]}
        onSave={vi.fn()}
      />,
    );

    await user.clear(screen.getByLabelText(/Server URL/));
    await user.type(
      screen.getByLabelText(/Server URL/),
      "https://typed.example.com/mcp",
    );

    // A status tick replaces the server object and the name array wholesale.
    rerender(
      <OAuthProfileModal
        open
        onOpenChange={vi.fn()}
        server={{ ...server, connectionStatus: "connecting" } as ServerWithName}
        existingServerNames={["oauth-flow-target"]}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(/Server URL/)).toHaveValue(
      "https://typed.example.com/mcp",
    );
  });

  it("still reseeds when an agent re-targets an already-open modal", () => {
    // The churn guard above must not swallow a genuine new prefill: the agent
    // command sets a seed and opens the modal even when it is already open.
    const { rerender } = render(
      <OAuthProfileModal
        open
        onOpenChange={vi.fn()}
        existingServerNames={[]}
        onSave={vi.fn()}
        agentSeed={{ serverUrl: "https://first.example.com/mcp" }}
      />,
    );
    expect(screen.getByLabelText(/Server URL/)).toHaveValue(
      "https://first.example.com/mcp",
    );

    rerender(
      <OAuthProfileModal
        open
        onOpenChange={vi.fn()}
        existingServerNames={[]}
        onSave={vi.fn()}
        agentSeed={{ serverUrl: "https://second.example.com/mcp" }}
      />,
    );

    expect(screen.getByLabelText(/Server URL/)).toHaveValue(
      "https://second.example.com/mcp",
    );
  });
});
