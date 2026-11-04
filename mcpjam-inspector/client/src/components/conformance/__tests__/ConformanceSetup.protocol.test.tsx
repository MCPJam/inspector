import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConnectedServer,
  createHttpServerConfig,
} from "@/test/factories";
import { ConformanceSetup } from "../ConformanceSetup";
import { RUN_LABEL } from "../ConformancePageChrome";
import type { ConformanceConnectionResult } from "@/shared/conformance-connection";

const { check } = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock("@/lib/apis/conformance-connection-api", () => ({
  checkConformanceConnection: check,
}));
vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: vi.fn(async () => ({ tools: [] })),
}));

const server = createConnectedServer({
  name: "bart",
  config: createHttpServerConfig("https://bart.test/mcp"),
});
function setup() {
  const onRun = vi.fn();
  const onConnectServer = vi.fn(async () => "ready" as const);
  const props = {
    servers: [server],
    initialServerName: "bart",
    initialVersionPin: "2026-07-28" as const,
    initialSelection: {
      protocol: ["modern-server-discover" as const],
      apps: [],
      tasks: [],
      oauth: false,
    },
    onRun,
    onCancel: vi.fn(),
    onConnectServer,
  };
  return {
    ...render(<ConformanceSetup {...props} />),
    props,
    onRun,
    onConnectServer,
  };
}
beforeEach(() => {
  check.mockReset();
});

describe("setup protocol connection gate", () => {
  it("blocks both steps until the chosen version connects, then runs normally", async () => {
    let resolve: (value: ConformanceConnectionResult) => void = () => {
      throw new Error("Promise not initialized");
    };
    check.mockImplementation(
      () =>
        new Promise<ConformanceConnectionResult>((done) => {
          resolve = done;
        }),
    );
    const { onRun, rerender, props } = setup();
    expect(screen.getByText("Connecting with 2026-07-28…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(onRun).not.toHaveBeenCalled();
    await act(async () => resolve({ status: "ready" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    rerender(
      <ConformanceSetup
        {...props}
        servers={[
          { ...server, config: createHttpServerConfig("https://new.test/mcp") },
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: RUN_LABEL })).toBeDisabled();
    expect(onRun).not.toHaveBeenCalled();
    await act(async () => resolve({ status: "ready" }));
    expect(screen.getByRole("button", { name: RUN_LABEL })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: RUN_LABEL }));
    expect(onRun).toHaveBeenCalledWith(
      "bart",
      "2026-07-28",
      expect.anything(),
      expect.anything(),
    );
  });

  it("shows a confirmed refusal and focuses the version picker from step 2", async () => {
    check.mockResolvedValueOnce({ status: "ready" });
    const { onRun, onConnectServer, rerender, props } = setup();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    check.mockResolvedValueOnce({
      status: "unsupported",
      protocolVersion: "2026-07-28",
      supportedVersions: ["2025-06-18"],
    });
    rerender(
      <ConformanceSetup
        {...props}
        servers={[
          { ...server, config: createHttpServerConfig("https://new.test/mcp") },
        ]}
      />,
    );
    await screen.findByText("bart doesn’t support 2026-07-28.");
    expect(screen.getByText("Server offers: 2025-06-18.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: RUN_LABEL })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Change version" }));
    expect(
      screen.getByRole("combobox", { name: "Select protocol version" }),
    ).toHaveFocus();
    expect(onRun).not.toHaveBeenCalled();
    expect(onConnectServer).not.toHaveBeenCalled();
  });

  it("requests sign-in only after an explicit click and checks again", async () => {
    check
      .mockResolvedValueOnce({
        status: "auth-required",
        message: "Unauthorized",
      })
      .mockResolvedValueOnce({ status: "ready" });
    const { onConnectServer } = setup();
    await screen.findByRole("button", { name: "Sign in" });
    expect(onConnectServer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(onConnectServer).toHaveBeenCalledWith("bart", { signIn: true }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
    );
  });

  it("blocks Run if the main server disconnects after validation", async () => {
    check.mockResolvedValue({ status: "ready" });
    const { rerender, props } = setup();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    rerender(
      <ConformanceSetup
        {...props}
        servers={[{ ...server, connectionStatus: "disconnected" }]}
      />,
    );
    expect(screen.getByRole("button", { name: RUN_LABEL })).toBeDisabled();
  });
});
