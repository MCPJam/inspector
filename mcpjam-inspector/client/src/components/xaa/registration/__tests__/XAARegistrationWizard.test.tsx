import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { XAARegistrationWizard } from "../XAARegistrationWizard";
import type { XaaResourceApp } from "@/lib/xaa/types";

let flagValue: boolean | undefined = true;
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => flagValue,
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
vi.mock("@/lib/xaa/discovery-client", () => ({
  discoverAuthorizationServer: (input: unknown) => discoverMock(input),
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

    it("requires a token endpoint in own-AS mode before saving", async () => {
      const user = userEvent.setup();
      renderWizard();
      await fillBasicInfoAndAdvance(user);

      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Token endpoint is required",
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
      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
      const payload = upsert.mock.calls[0]![0] as Record<string, unknown>;
      expect(payload.id).toBe("app_1");
      expect(payload).not.toHaveProperty("secret");
    });
  });

  it("saves a new registration with the entered values", async () => {
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
    });
  });
});
