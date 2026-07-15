import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { XAASetupAppsSection } from "../XAASetupAppsSection";
import type { XaaManagedConnection, XaaResourceApp } from "@/lib/xaa/types";

let resourceApps: XaaResourceApp[] = [];
const removeMock = vi.fn(async () => undefined);
vi.mock("@/hooks/useXaaResourceApps", () => ({
  useXaaResourceApps: () => ({
    resourceApps,
    isLoading: false,
    isAuthenticated: true,
    error: null,
    upsert: vi.fn(),
    remove: removeMock,
  }),
}));

let connections: XaaManagedConnection[] = [];
vi.mock("@/hooks/useXaaManagedConnections", () => ({
  useXaaManagedConnections: () => ({
    connections,
    connectionByAppId: new Map(connections.map((c) => [c.resourceAppId, c])),
    isLoading: false,
    isAuthenticated: true,
    error: null,
    upsertConnection: vi.fn(),
    removeConnection: vi.fn(),
  }),
}));

vi.mock("@/components/xaa/registration/XAARegistrationWizard", () => ({
  XAARegistrationWizard: ({ open }: { open: boolean }) =>
    open ? <div data-testid="xaa-reg-wizard-open" /> : null,
}));

const openInDebuggerMock = vi.fn();
vi.mock("@/lib/app-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/app-navigation")>();
  return {
    ...actual,
    openXaaAppInDebugger: (appId: string) => openInDebuggerMock(appId),
  };
});

const ORG_ID = "org_test";

function app(id: string, name: string): XaaResourceApp {
  return {
    id,
    name,
    resourceType: "mcp",
    resourceUrl: `https://${id}.example.test/mcp`,
    authServerMode: "own",
    hasSecret: false,
    createdAt: 1,
    updatedAt: 2,
  };
}

function connection(
  appId: string,
  enabled: boolean,
): XaaManagedConnection {
  return {
    _id: `conn_${appId}`,
    resourceAppId: appId,
    enabled,
    scopeMode: "all",
    assignments: [],
    createdAt: 1,
    updatedAt: 2,
  };
}

describe("XAASetupAppsSection", () => {
  beforeEach(() => {
    resourceApps = [app("app_1", "Files API"), app("app_2", "Calendar")];
    connections = [connection("app_1", true), connection("app_2", false)];
    removeMock.mockClear();
    openInDebuggerMock.mockClear();
  });

  it("shows a connection-status column per app", () => {
    resourceApps.push(app("app_3", "Orphan"));
    render(<XAASetupAppsSection organizationId={ORG_ID} canManage />);

    expect(
      screen.getByTestId("xaa-setup-app-app_1"),
    ).toHaveTextContent("Connected");
    expect(
      screen.getByTestId("xaa-setup-app-app_2"),
    ).toHaveTextContent("Disabled");
    expect(
      screen.getByTestId("xaa-setup-app-app_3"),
    ).toHaveTextContent("Not connected");
  });

  it("deep links into the debugger with the app preselected", async () => {
    const user = userEvent.setup();
    render(<XAASetupAppsSection organizationId={ORG_ID} canManage />);

    await user.click(
      screen.getByRole("button", { name: /test files api in debugger/i }),
    );
    expect(openInDebuggerMock).toHaveBeenCalledWith("app_1");
  });

  it("opens the registration wizard for create and edit", async () => {
    const user = userEvent.setup();
    render(<XAASetupAppsSection organizationId={ORG_ID} canManage />);

    await user.click(screen.getByRole("button", { name: /register/i }));
    expect(screen.getByTestId("xaa-reg-wizard-open")).toBeInTheDocument();
  });

  it("deletes after confirmation", async () => {
    const user = userEvent.setup();
    render(<XAASetupAppsSection organizationId={ORG_ID} canManage />);

    await user.click(screen.getByRole("button", { name: /delete files api/i }));
    await user.click(await screen.findByRole("button", { name: /^delete$/i }));

    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("app_1"));
  });

  it("contains a failed delete (no unhandled rejection; dialog stays open)", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      removeMock.mockRejectedValueOnce(new Error("boom"));
      const user = userEvent.setup();
      render(<XAASetupAppsSection organizationId={ORG_ID} canManage />);

      await user.click(
        screen.getByRole("button", { name: /delete files api/i }),
      );
      await user.click(
        await screen.findByRole("button", { name: /^delete$/i }),
      );
      await waitFor(() => expect(removeMock).toHaveBeenCalledWith("app_1"));

      // Failure keeps the confirm dialog open for retry/cancel (the hook
      // surfaces the message inline via its `error` state).
      expect(
        screen.getByRole("button", { name: /^delete$/i }),
      ).toBeInTheDocument();

      // Drain the task queue so an escaped rejection would have been reported.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("locks register/edit/delete for non-admins but keeps the debugger link live", async () => {
    const user = userEvent.setup();
    render(
      <XAASetupAppsSection organizationId={ORG_ID} canManage={false} />,
    );

    for (const name of [
      /register resource app/i,
      /edit files api/i,
      /delete files api/i,
    ]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    }

    await user.click(
      screen.getByRole("button", { name: /test files api in debugger/i }),
    );
    expect(openInDebuggerMock).toHaveBeenCalledWith("app_1");
    expect(removeMock).not.toHaveBeenCalled();
  });
});
