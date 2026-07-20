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

  it("allows saving an existing target under its own unchanged name", async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal({
      server: createServer("oauth-flow-target"),
      existingServerNames: ["oauth-flow-target", "staging-mcp"],
    });

    await user.click(screen.getByRole("button", { name: "Save configuration" }));

    expect(onSave).toHaveBeenCalledTimes(1);
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
