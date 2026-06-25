import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { XAAServerModal } from "../XAAServerModal";
import type { ServerWithName } from "@/hooks/use-app-state";

afterEach(() => {
  vi.restoreAllMocks();
});

function renderModal(
  props?: Partial<React.ComponentProps<typeof XAAServerModal>>,
) {
  const onSave = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <XAAServerModal
      open
      onOpenChange={onOpenChange}
      existingServerNames={[]}
      onSave={onSave}
      {...props}
    />,
  );
  return { onSave, onOpenChange };
}

describe("XAAServerModal", () => {
  it("emits ServerFormData with the XAA discriminator + resource-AS credentials on save", async () => {
    const user = userEvent.setup();
    const { onSave, onOpenChange } = renderModal();

    await user.type(screen.getByLabelText(/Server Name/), "staging-mcp");
    await user.type(
      screen.getByLabelText(/Server URL/),
      "https://staging.mcp.example.com",
    );
    await user.type(screen.getByLabelText(/Client ID/), "staging-client");
    await user.type(screen.getByLabelText(/Client Secret/), "super-secret");
    await user.type(screen.getByLabelText("Scopes"), "read:tools read:resources");
    await user.type(
      screen.getByLabelText("Authorization Server Issuer"),
      "https://auth.staging.example.com",
    );

    await user.click(screen.getByRole("button", { name: "Save configuration" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const { formData } = onSave.mock.calls[0][0];
    expect(formData).toMatchObject({
      name: "staging-mcp",
      type: "http",
      url: "https://staging.mcp.example.com",
      // Same discriminator the /servers Connect page writes — not plain OAuth.
      useXaa: true,
      useOAuth: false,
      authServerMode: "mcpjam",
      clientId: "staging-client",
      clientSecret: "super-secret",
      oauthScopes: ["read:tools", "read:resources"],
      xaaAuthzIssuer: "https://auth.staging.example.com",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("allows a public client with no secret and a blank issuer", async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal();

    await user.type(screen.getByLabelText(/Server Name/), "beta-mcp");
    await user.type(
      screen.getByLabelText(/Server URL/),
      "https://beta.mcp.example.com",
    );
    await user.type(screen.getByLabelText(/Client ID/), "beta-client");

    await user.click(screen.getByRole("button", { name: "Save configuration" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const { formData } = onSave.mock.calls[0][0];
    expect(formData.clientSecret).toBeUndefined();
    expect(formData.xaaAuthzIssuer).toBe("");
    expect(formData.oauthScopes).toEqual([]);
  });

  it("prefills fields and shows a Clear control for a saved secret when editing", () => {
    const server = {
      name: "prod-mcp",
      config: { url: "https://prod.mcp.example.com/mcp" },
      oauthFlowProfile: {
        serverUrl: "https://prod.mcp.example.com/mcp",
        clientId: "prod-client",
        clientSecret: "",
        scopes: "read write",
        customHeaders: [],
      },
      xaaAuthzIssuer: "https://auth.prod.example.com",
      hasClientSecret: true,
      useOAuth: true,
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
    } as unknown as ServerWithName;

    renderModal({ server });

    expect(screen.getByLabelText(/Server Name/)).toHaveValue("prod-mcp");
    expect(screen.getByLabelText(/Server URL/)).toHaveValue(
      "https://prod.mcp.example.com/mcp",
    );
    expect(screen.getByLabelText(/Client ID/)).toHaveValue("prod-client");
    expect(screen.getByLabelText("Scopes")).toHaveValue("read write");
    expect(screen.getByLabelText("Authorization Server Issuer")).toHaveValue(
      "https://auth.prod.example.com",
    );
    // A saved secret shows the replace-style input plus a Clear control
    // (shared with the /servers Connect page), not masked placeholder text.
    expect(screen.getByLabelText(/Client Secret/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Clear" }),
    ).toBeInTheDocument();
  });

  it("clears the saved secret when the creator chooses Clear", async () => {
    const user = userEvent.setup();
    const server = {
      name: "prod-mcp",
      config: { url: "https://prod.mcp.example.com/mcp" },
      oauthFlowProfile: {
        serverUrl: "https://prod.mcp.example.com/mcp",
        clientId: "prod-client",
        clientSecret: "",
        scopes: "",
        customHeaders: [],
      },
      hasClientSecret: true,
      useOAuth: true,
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
    } as unknown as ServerWithName;

    const { onSave } = renderModal({ server });

    await user.click(screen.getByRole("button", { name: "Clear" }));
    await user.click(screen.getByRole("button", { name: "Save configuration" }));

    const { formData } = onSave.mock.calls[0][0];
    expect(formData.clearClientSecret).toBe(true);
    expect(formData.clientSecret).toBeUndefined();
  });

  it("prefills the per-server simulated identity from the server config", () => {
    const server = {
      name: "prod-mcp",
      config: { url: "https://prod.mcp.example.com/mcp" },
      useXaa: true,
      xaaSubject: "alice",
      xaaEmail: "alice@example.com",
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
    } as unknown as ServerWithName;

    renderModal({ server });

    expect(screen.getByLabelText("Subject (sub)")).toHaveValue("alice");
    expect(screen.getByLabelText("Email")).toHaveValue("alice@example.com");
  });

  it("persists the per-server simulated identity in the saved form data", async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal();

    await user.type(screen.getByLabelText(/Server Name/), "staging-mcp");
    await user.type(
      screen.getByLabelText(/Server URL/),
      "https://staging.mcp.example.com",
    );
    await user.type(screen.getByLabelText(/Client ID/), "staging-client");
    await user.type(screen.getByLabelText("Subject (sub)"), "bob");
    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );

    const { formData } = onSave.mock.calls[0][0];
    expect(formData.xaaSubject).toBe("bob");
  });

  it("rejects a duplicate name when creating a new server", async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal({ existingServerNames: ["staging-mcp"] });

    await user.type(screen.getByLabelText(/Server Name/), "staging-mcp");
    await user.type(
      screen.getByLabelText(/Server URL/),
      "https://staging.mcp.example.com",
    );
    await user.type(screen.getByLabelText(/Client ID/), "staging-client");
    await user.click(screen.getByRole("button", { name: "Save configuration" }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/already exists/i);
  });

  it("stays open and preserves the entered values when the save rejects", async () => {
    const user = userEvent.setup();
    const onSave = vi
      .fn()
      .mockRejectedValue(new Error("Hosted mode requires HTTPS server URLs"));
    const onOpenChange = vi.fn();
    render(
      <XAAServerModal
        open
        onOpenChange={onOpenChange}
        existingServerNames={[]}
        onSave={onSave}
      />,
    );

    await user.type(screen.getByLabelText(/Server Name/), "staging-mcp");
    await user.type(
      screen.getByLabelText(/Server URL/),
      "https://staging.mcp.example.com",
    );
    await user.type(screen.getByLabelText(/Client ID/), "staging-client");
    await user.type(screen.getByLabelText(/Client Secret/), "super-secret");
    await user.type(
      screen.getByLabelText("Scopes"),
      "read:tools read:resources",
    );

    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );

    expect(onSave).toHaveBeenCalledTimes(1);
    // The modal surfaces the rejection inline and never closes.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Hosted mode requires HTTPS server URLs/i,
    );

    // Every entered value is still in the form, so there's nothing to re-type.
    expect(screen.getByLabelText(/Server Name/)).toHaveValue("staging-mcp");
    expect(screen.getByLabelText(/Server URL/)).toHaveValue(
      "https://staging.mcp.example.com",
    );
    expect(screen.getByLabelText(/Client ID/)).toHaveValue("staging-client");
    expect(screen.getByLabelText(/Client Secret/)).toHaveValue("super-secret");
    expect(screen.getByLabelText("Scopes")).toHaveValue(
      "read:tools read:resources",
    );

    // The submit button is interactive again for a retry.
    expect(
      screen.getByRole("button", { name: "Save configuration" }),
    ).toBeEnabled();
  });
});
