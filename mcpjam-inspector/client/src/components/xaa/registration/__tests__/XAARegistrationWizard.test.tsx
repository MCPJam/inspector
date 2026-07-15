import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { XAARegistrationWizard } from "../XAARegistrationWizard";
import { AppStateProvider } from "@/state/app-state-context";
import type { AppState } from "@/state/app-types";
import type { ServerWithName } from "@/hooks/use-app-state";
import type { XaaResourceApp } from "@/lib/xaa/types";

let flagValue: boolean | undefined = true;
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => flagValue,
}));

const trackMock = vi.fn();
vi.mock("@/lib/analytics", () => ({
  track: (...args: unknown[]) => trackMock(...args),
}));

const upsert = vi.fn(async () => ({ id: "app_new" }));
vi.mock("@/hooks/useXaaResourceApps", () => ({
  useXaaResourceApps: () => ({
    resourceApps: [],
    isLoading: false,
    isAuthenticated: true,
    error: null,
    upsert,
    remove: vi.fn(),
  }),
}));

const discoverMock = vi.fn();
const healthCheckMock = vi.fn();
vi.mock("@/lib/xaa/discovery-client", () => ({
  discoverAuthorizationServer: (input: unknown) => discoverMock(input),
  checkResourceHealth: (url: unknown) => healthCheckMock(url),
}));

const ORG_ID = "org_test";

function renderWizard(
  props: Partial<React.ComponentProps<typeof XAARegistrationWizard>> = {},
) {
  return render(
    <XAARegistrationWizard
      open
      onOpenChange={vi.fn()}
      organizationId={ORG_ID}
      {...props}
    />,
  );
}

function makeServer(
  name: string,
  config: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): ServerWithName {
  return {
    name,
    config,
    lastConnectionTime: new Date(),
    connectionStatus: "disconnected",
    retryCount: 0,
    ...extra,
  } as unknown as ServerWithName;
}

function makeAppState(servers: Record<string, ServerWithName>): AppState {
  return {
    projects: {
      proj_1: {
        id: "proj_1",
        name: "Project",
        servers,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    },
    activeProjectId: "proj_1",
    servers: {},
    selectedServer: "none",
    selectedMultipleServers: [],
    isMultiSelectMode: false,
  } as unknown as AppState;
}

function renderWizardWithServers(
  servers: Record<string, ServerWithName>,
  props: Partial<React.ComponentProps<typeof XAARegistrationWizard>> = {},
) {
  return render(
    <AppStateProvider appState={makeAppState(servers)}>
      <XAARegistrationWizard
        open
        onOpenChange={vi.fn()}
        organizationId={ORG_ID}
        {...props}
      />
    </AppStateProvider>,
  );
}

const PICKER_LABEL = "Start from an existing server";

const HTTP_SERVER = makeServer(
  "prod-mcp",
  {
    url: "https://prod.example.com/mcp",
    clientId: "client-abc",
    oauthScopes: ["read", "write"],
  },
  { xaaAuthzIssuer: "https://idp.example.com" },
);

const MCPJAM_MODE_SERVER = makeServer(
  "prod-mcp",
  {
    url: "https://prod.example.com/mcp",
    clientId: "client-abc",
    oauthScopes: ["read", "write"],
  },
  { xaaAuthzIssuer: "https://idp.example.com", authServerMode: "mcpjam" },
);

const STDIO_SERVER = makeServer("local-stdio", {
  command: "npx",
  args: ["my-server"],
});

async function fillBasicInfoAndAdvance(
  user: ReturnType<typeof userEvent.setup>,
) {
  await user.type(screen.getByLabelText("Name"), "My Resource");
  await user.type(
    screen.getByLabelText("Resource URL"),
    "https://resource.example.com/mcp",
  );
  await user.click(screen.getByRole("button", { name: "Next" }));
}

describe("XAARegistrationWizard", () => {
  beforeEach(() => {
    flagValue = true;
    upsert.mockClear();
    discoverMock.mockReset();
    healthCheckMock.mockReset();
    trackMock.mockClear();
  });

  describe("flag gating", () => {
    it("renders nothing when the flag is false", () => {
      flagValue = false;
      renderWizard();
      expect(screen.queryByText("Register resource app")).toBeNull();
    });

    it("renders nothing when the flag is undefined (bootstrap)", () => {
      flagValue = undefined;
      renderWizard();
      expect(screen.queryByText("Register resource app")).toBeNull();
    });
  });

  describe("step validation", () => {
    it("blocks step 1 -> 2 until name and a valid resource URL are set", async () => {
      const user = userEvent.setup();
      renderWizard();

      await user.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByRole("alert")).toHaveTextContent("Name is required.");

      await user.type(screen.getByLabelText("Name"), "My Resource");
      await user.type(screen.getByLabelText("Resource URL"), "not a url");
      await user.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Resource URL must be a valid http(s) URL.",
      );

      await user.clear(screen.getByLabelText("Resource URL"));
      await user.type(
        screen.getByLabelText("Resource URL"),
        "https://resource.example.com/mcp",
      );
      await user.click(screen.getByRole("button", { name: "Next" }));

      // Step 2 active: aria-current moves to the second step chip.
      const steps = screen.getAllByRole("listitem");
      expect(steps[1]).toHaveAttribute("aria-current", "step");
      expect(steps[0]).not.toHaveAttribute("aria-current");
    });

    it("requires a token endpoint in own-AS mode before advancing past step 2", async () => {
      const user = userEvent.setup();
      renderWizard();
      await fillBasicInfoAndAdvance(user);

      await user.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Token endpoint is required",
      );
      const steps = screen.getAllByRole("listitem");
      expect(steps[1]).toHaveAttribute("aria-current", "step");
      expect(upsert).not.toHaveBeenCalled();
    });

    it("rejects an invalid health check URL on step 3", async () => {
      const user = userEvent.setup();
      renderWizard();
      await fillBasicInfoAndAdvance(user);
      await user.type(
        screen.getByLabelText("Token endpoint"),
        "https://auth.example.com/oauth/token",
      );
      await user.click(screen.getByRole("button", { name: "Next" }));

      await user.type(screen.getByLabelText("Health check URL"), "not a url");
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Health check URL must be a valid http(s) URL.",
      );
      expect(upsert).not.toHaveBeenCalled();
    });
  });

  describe("discovery", () => {
    it("shows loading then the success verdict and autofills the token endpoint", async () => {
      let resolveDiscovery!: (value: unknown) => void;
      discoverMock.mockReturnValue(
        new Promise((resolve) => {
          resolveDiscovery = resolve;
        }),
      );

      const user = userEvent.setup();
      renderWizard();
      await fillBasicInfoAndAdvance(user);

      await user.type(
        screen.getByLabelText("Issuer"),
        "https://auth.example.com",
      );
      await user.click(screen.getByRole("button", { name: "Discover" }));

      expect(
        screen.getByRole("button", { name: /Discovering/ }),
      ).toBeDisabled();

      resolveDiscovery({
        issuer: "https://auth.example.com",
        tokenEndpoint: "https://auth.example.com/oauth/token",
        jwtBearerSupport: "pass",
        jwtBearerDetail: "Advertised in grant_types_supported.",
        hasTokenEndpoint: true,
        issuerMismatch: null,
        metadataUrl:
          "https://auth.example.com/.well-known/openid-configuration",
      });

      await waitFor(() =>
        expect(
          screen.getByTestId("xaa-reg-discovery-verdict"),
        ).toBeInTheDocument(),
      );
      expect(screen.getByLabelText("Token endpoint")).toHaveValue(
        "https://auth.example.com/oauth/token",
      );
      expect(discoverMock).toHaveBeenCalledWith({
        issuer: "https://auth.example.com",
      });
    });

    it("shows the error state when discovery fails", async () => {
      discoverMock.mockRejectedValue(
        new Error("No authorization server metadata found"),
      );

      const user = userEvent.setup();
      renderWizard();
      await fillBasicInfoAndAdvance(user);

      await user.type(
        screen.getByLabelText("Issuer"),
        "https://auth.example.com",
      );
      await user.click(screen.getByRole("button", { name: "Discover" }));

      await waitFor(() =>
        expect(screen.getByTestId("xaa-reg-discovery-error")).toHaveTextContent(
          "No authorization server metadata found",
        ),
      );
    });
  });

  describe("secret handling", () => {
    it("masks the secret input and never pre-fills it when editing", async () => {
      const user = userEvent.setup();
      const editing: XaaResourceApp = {
        id: "app_1",
        name: "Existing",
        resourceType: "mcp",
        resourceUrl: "https://resource.example.com/mcp",
        authServerMode: "own",
        tokenEndpoint: "https://auth.example.com/oauth/token",
        hasSecret: true,
        createdAt: 1,
        updatedAt: 2,
      };
      renderWizard({ editing });

      await user.click(screen.getByRole("button", { name: "Next" }));

      const secretInput = screen.getByLabelText("Client secret");
      expect(secretInput).toHaveAttribute("type", "password");
      expect(secretInput).toHaveValue("");
      expect(screen.getByText(/Leave blank to keep it/)).toBeInTheDocument();
    });

    it("omits a blank secret from the upsert payload when editing", async () => {
      const user = userEvent.setup();
      const editing: XaaResourceApp = {
        id: "app_1",
        name: "Existing",
        resourceType: "mcp",
        resourceUrl: "https://resource.example.com/mcp",
        authServerMode: "own",
        tokenEndpoint: "https://auth.example.com/oauth/token",
        hasSecret: true,
        createdAt: 1,
        updatedAt: 2,
      };
      renderWizard({ editing });

      await user.click(screen.getByRole("button", { name: "Next" }));
      await user.click(screen.getByRole("button", { name: "Next" }));
      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
      const payload = upsert.mock.calls[0]![0] as Record<string, unknown>;
      expect(payload.id).toBe("app_1");
      expect(payload).not.toHaveProperty("secret");
    });
  });

  it("saves a new registration with the entered values and fires telemetry", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    renderWizard({ onSaved });

    await fillBasicInfoAndAdvance(user);
    await user.type(
      screen.getByLabelText("Token endpoint"),
      "https://auth.example.com/oauth/token",
    );
    await user.type(screen.getByLabelText("Client ID"), "client-abc");
    await user.type(screen.getByLabelText("Client secret"), "cs-secret");
    await user.click(screen.getByRole("button", { name: "Next" }));

    await user.type(screen.getByLabelText("Scopes"), "read write");
    await user.type(
      screen.getByLabelText("Health check URL"),
      "https://resource.example.com/health",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("app_new"));
    expect(upsert).toHaveBeenCalledWith({
      name: "My Resource",
      resourceType: "mcp",
      resourceUrl: "https://resource.example.com/mcp",
      authServerMode: "own",
      tokenEndpoint: "https://auth.example.com/oauth/token",
      targetClientId: "client-abc",
      secret: "cs-secret",
      scopes: ["read", "write"],
      healthCheckUrl: "https://resource.example.com/health",
    });
    expect(trackMock).toHaveBeenCalledWith(
      "xaa_resource_app_saved",
      expect.objectContaining({
        location: "xaa_registration_wizard",
        resource_type: "mcp",
        auth_server_mode: "own",
      }),
    );
  });

  it("runs the health check from step 3 and shows the result", async () => {
    healthCheckMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      durationMs: 42,
    });

    const user = userEvent.setup();
    renderWizard();
    await fillBasicInfoAndAdvance(user);
    await user.type(
      screen.getByLabelText("Token endpoint"),
      "https://auth.example.com/oauth/token",
    );
    await user.click(screen.getByRole("button", { name: "Next" }));

    await user.type(
      screen.getByLabelText("Health check URL"),
      "https://resource.example.com/health",
    );
    await user.click(screen.getByRole("button", { name: "Check" }));

    await waitFor(() =>
      expect(screen.getByTestId("xaa-reg-health-result")).toHaveTextContent(
        "Reachable — HTTP 200 in 42ms",
      ),
    );
    expect(healthCheckMock).toHaveBeenCalledWith(
      "https://resource.example.com/health",
    );
  });

  it("shows the unreachable state without blocking the wizard", async () => {
    healthCheckMock.mockResolvedValue({
      ok: false,
      reason: "timeout",
      durationMs: 10000,
    });

    const user = userEvent.setup();
    renderWizard();
    await fillBasicInfoAndAdvance(user);
    await user.type(
      screen.getByLabelText("Token endpoint"),
      "https://auth.example.com/oauth/token",
    );
    await user.click(screen.getByRole("button", { name: "Next" }));

    await user.type(
      screen.getByLabelText("Health check URL"),
      "https://resource.example.com/health",
    );
    await user.click(screen.getByRole("button", { name: "Check" }));

    await waitFor(() =>
      expect(screen.getByTestId("xaa-reg-health-result")).toHaveTextContent(
        "Timed out",
      ),
    );
    // The failed check doesn't block saving.
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  describe("server picker", () => {
    it("lists only HTTP servers, excluding STDIO", async () => {
      const user = userEvent.setup();
      renderWizardWithServers({
        "prod-mcp": HTTP_SERVER,
        "local-stdio": STDIO_SERVER,
      });

      await user.click(screen.getByLabelText(PICKER_LABEL));
      expect(
        screen.getByRole("option", { name: "prod-mcp" }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: "local-stdio" })).toBeNull();
    });

    it("hides the picker when the project has no HTTP servers", () => {
      renderWizardWithServers({ "local-stdio": STDIO_SERVER });
      expect(screen.queryByLabelText(PICKER_LABEL)).toBeNull();
    });

    it("hides the picker outside an AppStateProvider (blank wizard unchanged)", () => {
      renderWizard();
      expect(screen.queryByLabelText(PICKER_LABEL)).toBeNull();
      expect(screen.getByLabelText("Name")).toHaveValue("");
    });

    it("hides the picker when editing an existing registration", () => {
      const editing: XaaResourceApp = {
        id: "app_1",
        name: "Existing",
        resourceType: "mcp",
        resourceUrl: "https://resource.example.com/mcp",
        authServerMode: "own",
        tokenEndpoint: "https://auth.example.com/oauth/token",
        hasSecret: false,
        createdAt: 1,
        updatedAt: 2,
      };
      renderWizardWithServers({ "prod-mcp": HTTP_SERVER }, { editing });
      expect(screen.queryByLabelText(PICKER_LABEL)).toBeNull();
      // The edit-seeded draft is untouched by the (hidden) picker.
      expect(screen.getByLabelText("Name")).toHaveValue("Existing");
    });

    it("picking prefills every derivable field across the steps", async () => {
      const user = userEvent.setup();
      renderWizardWithServers({ "prod-mcp": HTTP_SERVER });

      await user.click(screen.getByLabelText(PICKER_LABEL));
      await user.click(screen.getByRole("option", { name: "prod-mcp" }));
      await user.click(screen.getByRole("button", { name: "Edit details" }));

      expect(screen.getByLabelText("Name")).toHaveValue("prod-mcp");
      expect(screen.getByLabelText("Resource URL")).toHaveValue(
        "https://prod.example.com/mcp",
      );
      expect(screen.getByLabelText("MCP server")).toBeChecked();

      await user.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByLabelText("Issuer")).toHaveValue(
        "https://idp.example.com",
      );
      expect(screen.getByLabelText("Client ID")).toHaveValue("client-abc");

      await user.type(
        screen.getByLabelText("Token endpoint"),
        "https://idp.example.com/oauth/token",
      );
      await user.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByLabelText("Scopes")).toHaveValue("read write");
    });

    it("keeps manual edits after a pick, until an explicit re-pick overwrites", async () => {
      const user = userEvent.setup();
      const other = makeServer("staging-mcp", {
        url: "https://staging.example.com/mcp",
      });
      renderWizardWithServers({
        "prod-mcp": HTTP_SERVER,
        "staging-mcp": other,
      });

      await user.click(screen.getByLabelText(PICKER_LABEL));
      await user.click(screen.getByRole("option", { name: "prod-mcp" }));
      await user.click(screen.getByRole("button", { name: "Edit details" }));

      // Manual edit after the pick sticks.
      await user.clear(screen.getByLabelText("Name"));
      await user.type(screen.getByLabelText("Name"), "Custom name");
      expect(screen.getByLabelText("Name")).toHaveValue("Custom name");

      // A deliberate re-pick overwrites the prefillable fields again —
      // including clearing values the new server has no data for, so the
      // draft never mixes two servers' details.
      await user.click(screen.getByLabelText(PICKER_LABEL));
      await user.click(screen.getByRole("option", { name: "staging-mcp" }));
      await user.click(screen.getByRole("button", { name: "Edit details" }));
      expect(screen.getByLabelText("Name")).toHaveValue("staging-mcp");
      expect(screen.getByLabelText("Resource URL")).toHaveValue(
        "https://staging.example.com/mcp",
      );

      // Editing after the re-pick sticks too.
      await user.clear(screen.getByLabelText("Resource URL"));
      await user.type(
        screen.getByLabelText("Resource URL"),
        "https://edited.example.com/mcp",
      );
      expect(screen.getByLabelText("Resource URL")).toHaveValue(
        "https://edited.example.com/mcp",
      );
    });

    it("never touches fields the picker has no data for (secret survives a pick)", async () => {
      const user = userEvent.setup();
      renderWizardWithServers({ "prod-mcp": HTTP_SERVER });

      await user.type(screen.getByLabelText("Name"), "Manual");
      await user.type(
        screen.getByLabelText("Resource URL"),
        "https://manual.example.com/mcp",
      );
      await user.click(screen.getByRole("button", { name: "Next" }));
      await user.type(screen.getByLabelText("Client secret"), "cs-secret");
      await user.click(screen.getByRole("button", { name: "Back" }));

      await user.click(screen.getByLabelText(PICKER_LABEL));
      await user.click(screen.getByRole("option", { name: "prod-mcp" }));
      await user.click(screen.getByRole("button", { name: "Edit details" }));
      expect(screen.getByLabelText("Name")).toHaveValue("prod-mcp");

      await user.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByLabelText("Client secret")).toHaveValue("cs-secret");
    });

    it("saves a picked-then-completed registration with today's payload shape", async () => {
      const user = userEvent.setup();
      renderWizardWithServers({ "prod-mcp": HTTP_SERVER });

      await user.click(screen.getByLabelText(PICKER_LABEL));
      await user.click(screen.getByRole("option", { name: "prod-mcp" }));
      await user.click(screen.getByRole("button", { name: "Edit details" }));
      await user.click(screen.getByRole("button", { name: "Next" }));
      await user.type(
        screen.getByLabelText("Token endpoint"),
        "https://idp.example.com/oauth/token",
      );
      await user.click(screen.getByRole("button", { name: "Next" }));
      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
      // Exact-match: the snapshot payload carries no reference to the picked
      // server row and no new fields.
      expect(upsert).toHaveBeenCalledWith({
        name: "prod-mcp",
        resourceType: "mcp",
        resourceUrl: "https://prod.example.com/mcp",
        authServerMode: "own",
        tokenEndpoint: "https://idp.example.com/oauth/token",
        issuer: "https://idp.example.com",
        targetClientId: "client-abc",
        scopes: ["read", "write"],
      });
    });
  });

  describe("one-click review", () => {
    it("collapses to a review summary of the derived values after a pick", async () => {
      const user = userEvent.setup();
      renderWizardWithServers({ "prod-mcp": HTTP_SERVER });

      await user.click(screen.getByLabelText(PICKER_LABEL));
      await user.click(screen.getByRole("option", { name: "prod-mcp" }));

      const review = screen.getByTestId("xaa-reg-review");
      expect(review).toHaveTextContent("prod-mcp");
      expect(review).toHaveTextContent("https://prod.example.com/mcp");
      // The pick never sets the auth-server mode — the summary presents the
      // wizard's default honestly, plus the server's issuer snapshot.
      expect(review).toHaveTextContent("My own auth server");
      expect(review).toHaveTextContent("https://idp.example.com");
      expect(review).toHaveTextContent("client-abc");
      expect(review).toHaveTextContent("read");
      expect(review).toHaveTextContent("write");

      // The step flow is collapsed: no step chips, no form fields.
      expect(
        screen.queryByRole("list", { name: "Registration steps" }),
      ).toBeNull();
      expect(screen.queryByLabelText("Name")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Register app" }),
      ).toBeInTheDocument();
      // Re-picking stays possible from the review.
      expect(screen.getByLabelText(PICKER_LABEL)).toBeInTheDocument();
    });

    it("shows 'none declared' scopes and the missing issuer honestly", async () => {
      const user = userEvent.setup();
      renderWizardWithServers({
        "staging-mcp": makeServer("staging-mcp", {
          url: "https://staging.example.com/mcp",
        }),
      });

      await user.click(screen.getByLabelText(PICKER_LABEL));
      await user.click(screen.getByRole("option", { name: "staging-mcp" }));

      const review = screen.getByTestId("xaa-reg-review");
      expect(review).toHaveTextContent("no issuer set");
      expect(review).toHaveTextContent("none declared");
      expect(review).not.toHaveTextContent("Client ID");
    });

    it("registers with the exact same payload the step flow sends", async () => {
      const user = userEvent.setup();

      // Route A: pick, then walk the steps and save (today's flow).
      const stepFlow = renderWizardWithServers({ "prod-mcp": HTTP_SERVER });
      await user.click(screen.getByLabelText(PICKER_LABEL));
      await user.click(screen.getByRole("option", { name: "prod-mcp" }));
      await user.click(screen.getByRole("button", { name: "Edit details" }));
      await user.click(screen.getByRole("button", { name: "Next" }));
      await user.type(
        screen.getByLabelText("Token endpoint"),
        "https://idp.example.com/oauth/token",
      );
      await user.click(screen.getByRole("button", { name: "Next" }));
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
      stepFlow.unmount();

      // Route B: same draft via one click. The token endpoint is typed
      // before the pick (a pick never touches it), so validation passes.
      renderWizardWithServers({ "prod-mcp": HTTP_SERVER });
      await user.type(screen.getByLabelText("Name"), "placeholder");
      await user.type(
        screen.getByLabelText("Resource URL"),
        "https://placeholder.example.com/mcp",
      );
      await user.click(screen.getByRole("button", { name: "Next" }));
      await user.type(
        screen.getByLabelText("Token endpoint"),
        "https://idp.example.com/oauth/token",
      );
      await user.click(screen.getByRole("button", { name: "Back" }));
      await user.click(screen.getByLabelText(PICKER_LABEL));
      await user.click(screen.getByRole("option", { name: "prod-mcp" }));
      await user.click(screen.getByRole("button", { name: "Register app" }));

      await waitFor(() => expect(upsert).toHaveBeenCalledTimes(2));
      expect(upsert.mock.calls[1]![0]).toEqual(upsert.mock.calls[0]![0]);
      expect(trackMock).toHaveBeenCalledWith(
        "xaa_resource_app_saved",
        expect.objectContaining({
          location: "xaa_registration_wizard",
          resource_type: "mcp",
          auth_server_mode: "own",
        }),
      );
    });

    it("drops into edit mode at the failing step instead of dead-ending", async () => {
      const user = userEvent.setup();
      renderWizardWithServers({ "prod-mcp": HTTP_SERVER });

      await user.click(screen.getByLabelText(PICKER_LABEL));
      await user.click(screen.getByRole("option", { name: "prod-mcp" }));
      // Own-AS mode without a token endpoint: the one-click validation fails
      // at step 2, so the wizard expands there with the inline message.
      await user.click(screen.getByRole("button", { name: "Register app" }));

      expect(upsert).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Token endpoint is required",
      );
      const steps = screen.getAllByRole("listitem");
      expect(steps[1]).toHaveAttribute("aria-current", "step");
      expect(screen.getByLabelText("Token endpoint")).toHaveValue("");
    });

    it("'Edit details' expands the prefilled step flow with the picker intact", async () => {
      const user = userEvent.setup();
      renderWizardWithServers({ "prod-mcp": HTTP_SERVER });

      await user.click(screen.getByLabelText(PICKER_LABEL));
      await user.click(screen.getByRole("option", { name: "prod-mcp" }));
      await user.click(screen.getByRole("button", { name: "Edit details" }));

      expect(
        screen.getByRole("list", { name: "Registration steps" }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Name")).toHaveValue("prod-mcp");
      expect(screen.getByLabelText(PICKER_LABEL)).toBeInTheDocument();
      expect(screen.queryByTestId("xaa-reg-review")).toBeNull();
    });

    it("re-picking from edit mode returns to the review", async () => {
      const user = userEvent.setup();
      renderWizardWithServers({
        "prod-mcp": HTTP_SERVER,
        "staging-mcp": makeServer("staging-mcp", {
          url: "https://staging.example.com/mcp",
        }),
      });

      await user.click(screen.getByLabelText(PICKER_LABEL));
      await user.click(screen.getByRole("option", { name: "prod-mcp" }));
      await user.click(screen.getByRole("button", { name: "Edit details" }));
      await user.click(screen.getByLabelText(PICKER_LABEL));
      await user.click(screen.getByRole("option", { name: "staging-mcp" }));

      expect(screen.getByTestId("xaa-reg-review")).toBeInTheDocument();
      expect(screen.getByTestId("xaa-reg-review")).toHaveTextContent(
        "staging-mcp",
      );
    });

    it("clearing the pick returns to the blank manual wizard", async () => {
      const user = userEvent.setup();
      renderWizardWithServers({ "prod-mcp": HTTP_SERVER });

      await user.click(screen.getByLabelText(PICKER_LABEL));
      await user.click(screen.getByRole("option", { name: "prod-mcp" }));
      await user.click(
        screen.getByRole("button", {
          name: "Clear selection and start from scratch",
        }),
      );

      expect(screen.queryByTestId("xaa-reg-review")).toBeNull();
      expect(screen.getByLabelText("Name")).toHaveValue("");
      expect(screen.getByLabelText(PICKER_LABEL)).toBeInTheDocument();
      expect(
        screen.getByRole("list", { name: "Registration steps" }),
      ).toBeInTheDocument();
    });

    it("surfaces the save error in review mode", async () => {
      upsert.mockRejectedValueOnce(new Error("backend said no"));
      const user = userEvent.setup();
      renderWizardWithServers({ "prod-mcp": MCPJAM_MODE_SERVER });

      // The server row stores authServerMode "mcpjam"; the pick carries it
      // over, so the one-click path passes auth-server validation with no
      // token endpoint.
      await user.click(screen.getByLabelText(PICKER_LABEL));
      await user.click(screen.getByRole("option", { name: "prod-mcp" }));

      expect(screen.getByTestId("xaa-reg-review")).toHaveTextContent(
        "MCPJam test auth server",
      );
      await user.click(screen.getByRole("button", { name: "Register app" }));

      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent("backend said no"),
      );
      // Still in review — the user can retry or edit.
      expect(
        screen.getByRole("button", { name: "Register app" }),
      ).toBeInTheDocument();
    });
  });
});
