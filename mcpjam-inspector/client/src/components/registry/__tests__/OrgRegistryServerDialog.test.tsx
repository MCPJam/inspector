/**
 * The add / promote / edit dialog.
 *
 * What matters here is that the DERIVED facts stay derived. Version and auth
 * posture come off the probe and are rendered, never typed — a field a person
 * can edit is a field that will eventually disagree with the server it
 * describes. And an egress refusal shows the route's own generic sentence
 * with no retry: the reason a target was blocked is not something to hand
 * back to whoever supplied the URL.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { deriveOrgRegistryServer } = vi.hoisted(() => ({
  deriveOrgRegistryServer: vi.fn(),
}));

vi.mock("@/lib/apis/web/org-registry-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/apis/web/org-registry-api")>()),
  deriveOrgRegistryServer,
}));

import { OrgRegistryServerDialog } from "../OrgRegistryServerDialog";
import { WebApiError } from "@/lib/apis/web/base";

const DERIVED_FACTS = {
  status: "oauth_required" as const,
  serverName: "example-mcp",
  serverVersion: "1.4.2",
  title: "Example Docs",
  authRequired: true,
  registrationStrategies: [] as Array<"preregistered" | "dcr" | "cimd">,
  endpointUrl: "https://mcp.example.com/mcp",
};

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof OrgRegistryServerDialog>> = {}
) {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(
    <OrgRegistryServerDialog
      open
      onOpenChange={() => {}}
      projectId="proj_1"
      onSubmit={onSubmit}
      {...overrides}
    />
  );
  return { onSubmit };
}

beforeEach(() => {
  deriveOrgRegistryServer.mockReset();
  deriveOrgRegistryServer.mockResolvedValue(DERIVED_FACTS);
});

describe("OrgRegistryServerDialog — paste a link", () => {
  it("probes the pasted URL and prefills from what the server said", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(
      screen.getByLabelText("Server URL"),
      "https://mcp.example.com/mcp"
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Name")).toHaveValue("Example Docs")
    );
    // Read-only facts, rendered as badges rather than fields.
    expect(screen.getByText("v1.4.2")).toBeInTheDocument();
    expect(screen.getByText(/Requires sign-in/)).toBeInTheDocument();
    // No DCR and no CIMD resolved, so this server needs a client handed to it.
    expect(
      screen.getByText("Requires pre-registered client")
    ).toBeInTheDocument();
  });

  it("submits the derived snapshot alongside what the person typed", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog();

    await user.type(
      screen.getByLabelText("Server URL"),
      "https://mcp.example.com/mcp"
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Name")).toHaveValue("Example Docs")
    );
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Team Docs");
    await user.click(screen.getByRole("button", { name: "Add to registry" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      displayName: "Team Docs",
      url: "https://mcp.example.com/mcp",
      useOAuth: true,
      derived: {
        serverVersion: "1.4.2",
        authRequired: true,
        supportsDcr: false,
        supportsCimd: false,
      },
    });
  });

  it("shows a refusal as-is and stays on the URL step", async () => {
    const user = userEvent.setup();
    deriveOrgRegistryServer.mockRejectedValue(
      new WebApiError(
        400,
        "VALIDATION_ERROR",
        "That address can't be reached from MCPJam. Organization registry entries must point at a server on the public internet, over HTTPS."
      )
    );
    const { onSubmit } = renderDialog();

    await user.type(
      screen.getByLabelText("Server URL"),
      "http://localhost/mcp"
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        /public internet, over HTTPS/
      )
    );
    // Still on step one, with the URL intact so a typo can be fixed. And
    // nothing was saved.
    expect(screen.getByLabelText("Server URL")).toHaveValue(
      "http://localhost/mcp"
    );
    expect(onSubmit).not.toHaveBeenCalled();
    expect(deriveOrgRegistryServer).toHaveBeenCalledTimes(1);
  });
});

describe("OrgRegistryServerDialog — promote and edit", () => {
  it("opens straight at the confirm step and never probes", async () => {
    renderDialog({
      seed: {
        displayName: "Internal Docs",
        url: "https://mcp.example.com/mcp",
        useOAuth: true,
        sourceServerId: "srv_1",
        derived: {
          probedAt: 1,
          endpointUrl: "https://mcp.example.com/mcp",
          serverVersion: "2.0.0",
          authRequired: true,
          supportsDcr: true,
        },
      },
    });

    expect(screen.getByLabelText("Name")).toHaveValue("Internal Docs");
    expect(screen.getByText("v2.0.0")).toBeInTheDocument();
    // DCR resolved, so no pre-registered-client claim.
    expect(
      screen.queryByText("Requires pre-registered client")
    ).not.toBeInTheDocument();
    expect(deriveOrgRegistryServer).not.toHaveBeenCalled();
  });

  it("locks the URL on promote — the mutation refuses a mismatched one", () => {
    renderDialog({
      seed: {
        displayName: "Internal Docs",
        url: "https://mcp.example.com/mcp",
        sourceServerId: "srv_1",
        derived: { probedAt: 1, endpointUrl: "https://mcp.example.com/mcp" },
      },
    });

    // `addOrgRegistryServer` compares the entry URL against the source
    // server's own, so an editable field here would be one whose every edit
    // is a dead end.
    expect(screen.getByLabelText("Server URL")).toHaveAttribute("readonly");
  });

  it("leaves the URL editable when editing an existing entry", () => {
    renderDialog({
      seed: {
        registryServerId: "reg_1",
        displayName: "Internal Docs",
        url: "https://mcp.example.com/mcp",
      },
    });

    expect(screen.getByLabelText("Server URL")).not.toHaveAttribute("readonly");
  });

  it("re-probes when an edited URL changes the facts being saved", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog({
      seed: {
        registryServerId: "reg_1",
        displayName: "Internal Docs",
        url: "https://old.example/mcp",
        derived: {
          probedAt: 1,
          endpointUrl: "https://old.example/mcp",
          serverVersion: "1.0.0",
        },
      },
    });

    const urlInput = screen.getByLabelText("Server URL");
    await user.clear(urlInput);
    await user.type(urlInput, "https://new.example/mcp");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(deriveOrgRegistryServer).toHaveBeenCalledWith({
      url: "https://new.example/mcp",
      projectId: "proj_1",
    });
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      registryServerId: "reg_1",
      derived: { endpointUrl: "https://mcp.example.com/mcp" },
    });
  });

  it("carries sourceServerId through so the promote writes provenance", async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderDialog({
      seed: {
        displayName: "Internal Docs",
        url: "https://mcp.example.com/mcp",
        sourceServerId: "srv_1",
        derived: { probedAt: 1, endpointUrl: "https://mcp.example.com/mcp" },
      },
    });

    await user.click(screen.getByRole("button", { name: "Add to registry" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      sourceServerId: "srv_1",
    });
  });

  it("keeps a failed save on screen with the server's own message", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onSubmit = vi
      .fn()
      .mockRejectedValue(
        new Error("Organization registry entries must use an https:// URL")
      );
    render(
      <OrgRegistryServerDialog
        open
        onOpenChange={onOpenChange}
        projectId="proj_1"
        seed={{
          registryServerId: "reg_1",
          displayName: "Internal Docs",
          url: "https://mcp.example.com/mcp",
        }}
        onSubmit={onSubmit}
      />
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/https:\/\//)
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
