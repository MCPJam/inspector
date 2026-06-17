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
  it("emits ServerFormData with xaaAuthzIssuer and the OAuth credentials on save", async () => {
    const user = userEvent.setup();
    const { onSave, onOpenChange } = renderModal();

    await user.type(screen.getByLabelText(/Server Name/), "staging-mcp");
    await user.type(
      screen.getByLabelText(/Server URL/),
      "https://staging.mcp.example.com",
    );
    await user.type(screen.getByLabelText(/Client ID/), "staging-client");
    await user.type(screen.getByLabelText("Client Secret"), "super-secret");
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
      useOAuth: true,
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

  it("prefills fields and masks the saved secret when editing", () => {
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
    // A saved secret is masked behind Replace / Clear controls, not a field.
    expect(screen.getByText(/saved/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Replace" }),
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
});
