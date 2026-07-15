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
});
