import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { XAAServerModal } from "../XAAServerModal";
import type { ServerWithName } from "@/hooks/use-app-state";
import { fetchOAuthClientSecret } from "@/lib/apis/hosted-oauth-client-secret-api";

vi.mock("@/lib/apis/hosted-oauth-client-secret-api", () => ({
  fetchOAuthClientSecret: vi.fn(),
}));

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

// The issuer + simulated-identity fields live in a collapsed "Advanced"
// section (the modal no longer force-opens it), so tests that touch them
// expand it first.
async function expandAdvanced(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /^advanced$/i }));
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
    await expandAdvanced(user);
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
    // Untouched selector ⇒ the save omits registrationMode entirely (the
    // auto-clobber guard): the save-path `?? existing` merge preserves
    // whatever is stored, and the run resolves preregistered by default.
    expect("registrationMode" in formData).toBe(false);
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

  it("prefills fields and shows a Clear control for a saved secret when editing", async () => {
    const user = userEvent.setup();
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
    await expandAdvanced(user);
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

  it("reveals a saved client secret using the hosted server context", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchOAuthClientSecret).mockResolvedValue({
      clientSecret: "stored-super-secret",
    });
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

    renderModal({
      server,
      projectId: "project-123",
      hostedServerId: "server-456",
    });

    await user.click(screen.getByRole("button", { name: "Reveal" }));

    expect(fetchOAuthClientSecret).toHaveBeenCalledWith({
      projectId: "project-123",
      serverId: "server-456",
    });
    expect(screen.getByLabelText(/Client Secret/)).toHaveValue(
      "stored-super-secret",
    );
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

  it("prefills the per-server simulated identity from the server config", async () => {
    const user = userEvent.setup();
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

    await expandAdvanced(user);
    expect(screen.getByLabelText("Subject (sub)")).toHaveValue("alice");
    expect(screen.getByLabelText("Email")).toHaveValue("alice@example.com");
  });

  it("persists an edited complete identity pair in the saved form data", async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal();

    await user.type(screen.getByLabelText(/Server Name/), "staging-mcp");
    await user.type(
      screen.getByLabelText(/Server URL/),
      "https://staging.mcp.example.com",
    );
    await user.type(screen.getByLabelText(/Client ID/), "staging-client");
    await expandAdvanced(user);
    await user.type(screen.getByLabelText("Subject (sub)"), "bob");
    await user.type(screen.getByLabelText("Email"), "bob@example.com");
    await user.click(screen.getByRole("button", { name: "Save configuration" }));

    const { formData } = onSave.mock.calls[0][0];
    expect(formData.xaaSubject).toBe("bob");
    expect(formData.xaaEmail).toBe("bob@example.com");
  });

  it("omits the identity pair on an untouched save — never force-defaults to the signed-in email", async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal();

    await user.type(screen.getByLabelText(/Server Name/), "staging-mcp");
    await user.type(
      screen.getByLabelText(/Server URL/),
      "https://staging.mcp.example.com",
    );
    await user.type(screen.getByLabelText(/Client ID/), "staging-client");
    await user.click(screen.getByRole("button", { name: "Save configuration" }));

    const { formData } = onSave.mock.calls[0][0];
    // BOTH keys omitted: the save path preserves stored values and no
    // signed-in-email (or any other) default is injected.
    expect("xaaSubject" in formData).toBe(false);
    expect("xaaEmail" in formData).toBe(false);
  });

  it("round-trips a stored identity override atomically and clears it with two empty fields", async () => {
    const user = userEvent.setup();
    const server = {
      name: "prod-mcp",
      config: { url: "https://prod.mcp.example.com/mcp" },
      useXaa: true,
      oauthFlowProfile: {
        serverUrl: "https://prod.mcp.example.com/mcp",
        clientId: "prod-client",
        clientSecret: "",
        scopes: "",
        customHeaders: [],
      },
      xaaSubject: "alice",
      xaaEmail: "alice@example.com",
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
    } as unknown as ServerWithName;

    const { onSave } = renderModal({ server });

    // Untouched pair → omitted (round-trip preserves the stored values).
    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );
    let { formData } = onSave.mock.calls[0][0];
    expect("xaaSubject" in formData).toBe(false);
    expect("xaaEmail" in formData).toBe(false);

    // Explicit clear of BOTH fields → both emitted as "" so the backend
    // normalizes the pair away.
    onSave.mockClear();
    await expandAdvanced(user);
    await user.clear(screen.getByLabelText("Subject (sub)"));
    await user.clear(screen.getByLabelText("Email"));
    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );
    ({ formData } = onSave.mock.calls[0][0]);
    expect(formData.xaaSubject).toBe("");
    expect(formData.xaaEmail).toBe("");
  });

  it("blocks save on a partial identity pair with an actionable error", async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal();

    await user.type(screen.getByLabelText(/Server Name/), "staging-mcp");
    await user.type(
      screen.getByLabelText(/Server URL/),
      "https://staging.mcp.example.com",
    );
    await user.type(screen.getByLabelText(/Client ID/), "staging-client");
    await expandAdvanced(user);
    await user.type(screen.getByLabelText("Subject (sub)"), "bob");
    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /complete or clear the server identity override/i,
    );

    // Completing the pair unblocks the save.
    await user.type(screen.getByLabelText("Email"), "bob@example.com");
    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("requires a Client ID for the pre-registered strategy", async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal();

    await user.type(screen.getByLabelText(/Server Name/), "staging-mcp");
    await user.type(
      screen.getByLabelText(/Server URL/),
      "https://staging.mcp.example.com",
    );
    // Leave Client ID blank; default strategy is pre-registered.
    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/client id is required/i);
  });

  it("allows a blank Client ID for a dynamic (DCR) strategy and emits the choice", async () => {
    const user = userEvent.setup();
    const { onSave } = renderModal();

    await user.type(screen.getByLabelText(/Server Name/), "staging-mcp");
    await user.type(
      screen.getByLabelText(/Server URL/),
      "https://staging.mcp.example.com",
    );
    // Switch to DCR: Client ID is no longer required.
    await user.click(screen.getByLabelText("Registration"));
    await user.click(
      screen.getByRole("option", { name: /open dynamic registration/i }),
    );
    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );

    expect(onSave).toHaveBeenCalledTimes(1);
    const { formData } = onSave.mock.calls[0][0];
    expect(formData.registrationMode).toBe("dcr");
  });

  it("prefills the persisted registration strategy when editing", async () => {
    const user = userEvent.setup();
    const server = {
      name: "prod-mcp",
      config: { url: "https://prod.mcp.example.com/mcp" },
      useXaa: true,
      registrationMode: "cimd",
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
    } as unknown as ServerWithName;

    const { onSave } = renderModal({ server });

    // The selector displays the persisted choice…
    expect(screen.getByLabelText("Registration")).toHaveTextContent(/CIMD/i);
    // …and an untouched save OMITS the field so the `?? existing` merge
    // preserves the stored value rather than re-writing it.
    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );
    const { formData } = onSave.mock.calls[0][0];
    expect("registrationMode" in formData).toBe(false);
  });

  it("preserves a stored 'auto' mode on an untouched save (auto-clobber guard)", async () => {
    const user = userEvent.setup();
    // A server whose unified registrationMode was set to "auto" from the
    // Connect page. The debugger modal DISPLAYS the resolved default
    // (pre-registered) but must not write it back on save — that would
    // silently change the OAuth flow's behavior for the same server.
    const server = {
      name: "auto-mcp",
      config: { url: "https://auto.mcp.example.com/mcp" },
      useXaa: true,
      registrationMode: "auto",
      oauthFlowProfile: {
        serverUrl: "https://auto.mcp.example.com/mcp",
        clientId: "auto-client",
        clientSecret: "",
        scopes: "",
        customHeaders: [],
      },
      lastConnectionTime: new Date(),
      connectionStatus: "disconnected",
      retryCount: 0,
    } as unknown as ServerWithName;

    const { onSave } = renderModal({ server });

    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );
    const { formData } = onSave.mock.calls[0][0];
    expect("registrationMode" in formData).toBe(false);

    // An explicit edit DOES write the new choice.
    onSave.mockClear();
    await user.click(screen.getByLabelText("Registration"));
    await user.click(
      screen.getByRole("option", { name: /open dynamic registration/i }),
    );
    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );
    expect(onSave.mock.calls[0][0].formData.registrationMode).toBe("dcr");
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
    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );

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
