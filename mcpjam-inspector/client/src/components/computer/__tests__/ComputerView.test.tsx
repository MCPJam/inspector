import { render, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ComputerUsageView,
  ComputerView as ComputerViewModel,
} from "@/hooks/useProjectComputer";

const reserve = vi.fn(async () => ({} as never));
const deleteComputer = vi.fn(async () => ({ deleted: true }));
const mintToken = vi.fn(async () => ({ token: "t", expiresAt: 0 } as never));
let mockStatus: ComputerViewModel | null | undefined;
let mockUsage: ComputerUsageView | null | undefined;
let mockDataPlane:
  | { localConfigured: boolean; remoteDataPlaneUrl: string | null }
  | undefined;

vi.mock("@/hooks/useProjectComputer", () => ({
  useComputerStatus: () => mockStatus,
  useComputerUsage: () => mockUsage,
  useReserveComputer: () => reserve,
  useDeleteComputer: () => deleteComputer,
  useMintTerminalToken: () => mintToken,
  useComputersDataPlaneConfig: () => mockDataPlane,
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (sel: (s: { themeMode: string }) => unknown) =>
    sel({ themeMode: "dark" }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Stub the xterm terminal so the orchestration test needs no real terminal.
vi.mock("../ComputerTerminal", () => ({
  ComputerTerminal: (props: { baseUrl?: string }) => (
    <div data-testid="terminal-stub" data-base-url={props.baseUrl ?? ""} />
  ),
}));

import { ComputerView } from "../ComputerView";

afterEach(() => {
  vi.clearAllMocks();
  mockStatus = undefined;
  mockUsage = undefined;
  mockDataPlane = { localConfigured: true, remoteDataPlaneUrl: null };
});

const HOUR_MS = 60 * 60 * 1000;

function usage(overrides: Partial<ComputerUsageView> = {}): ComputerUsageView {
  return {
    mode: "shadow",
    creditsPerHour: 10,
    windowStartAt: 0,
    resetsAt: HOUR_MS,
    awakeMs: 0,
    allowanceMs: 30 * HOUR_MS,
    billedCredits: 0,
    forgivenCredits: 0,
    ...overrides,
  };
}

// Default for every test: this server IS a data plane (the pre-remote
// behavior). Individual tests override to exercise the delegation states.
mockDataPlane = { localConfigured: true, remoteDataPlaneUrl: null };

describe("ComputerView", () => {
  it("prompts to sign in when unauthenticated", () => {
    const { getByText } = render(
      <ComputerView projectId="p1" isAuthenticated={false} />
    );
    expect(getByText(/Sign in to use a personal computer/i)).toBeTruthy();
  });

  it("asks for a synced project when there is no projectId", () => {
    const { getByText } = render(
      <ComputerView projectId={null} isAuthenticated />
    );
    expect(getByText(/need a synced project/i)).toBeTruthy();
  });

  it("opening the terminal reserves the computer", async () => {
    mockStatus = null; // no computer yet
    const { getByText } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    fireEvent.click(getByText("Open terminal"));
    await waitFor(() =>
      expect(reserve).toHaveBeenCalledWith({ projectId: "p1" })
    );
  });

  it("mounts the terminal once the computer is ready", () => {
    mockStatus = {
      computerId: "c1",
      status: "ready",
      provider: "e2b",
    };
    const { getByText, getByTestId, queryByTestId } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    expect(queryByTestId("terminal-stub")).toBeNull();
    fireEvent.click(getByText("Open terminal"));
    // ready + open ⇒ terminal mounts; reserve still fires for wake safety only
    // when not ready, so it should NOT be called here.
    expect(getByTestId("terminal-stub")).toBeTruthy();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("delete requires confirmation then calls deleteComputer", async () => {
    mockStatus = { computerId: "c1", status: "ready", provider: "e2b" };
    const { getByText } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    fireEvent.click(getByText("Delete"));
    expect(getByText("Delete this computer?")).toBeTruthy();
    // The confirm button is the second "Delete" — click via the confirm row.
    fireEvent.click(getByText("Delete", { selector: "button" }));
    await waitFor(() =>
      expect(deleteComputer).toHaveBeenCalledWith({ projectId: "p1" })
    );
  });

  it("does not offer Delete once the computer is deleted", () => {
    mockStatus = { computerId: "c1", status: "deleted", provider: "e2b" };
    const { queryByText } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    expect(queryByText("Delete")).toBeNull();
  });

  it("shows a retry/close pane (not a stuck spinner) when the computer errors with the terminal open", () => {
    mockStatus = { computerId: "c1", status: "ready", provider: "e2b" };
    const { getByText, queryByText, queryByTestId, rerender } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    fireEvent.click(getByText("Open terminal"));
    expect(queryByTestId("terminal-stub")).toBeTruthy();

    mockStatus = {
      computerId: "c1",
      status: "error",
      provider: "e2b",
      lastError: "kaboom",
    };
    rerender(<ComputerView projectId="p1" isAuthenticated />);

    expect(queryByTestId("terminal-stub")).toBeNull();
    expect(queryByText(/Starting your computer/i)).toBeNull();
    expect(getByText("Try again")).toBeTruthy();
    expect(getByText("Close")).toBeTruthy();
  });

  it("shows an honest empty state when no data plane is available (no Open terminal)", () => {
    mockDataPlane = { localConfigured: false, remoteDataPlaneUrl: null };
    mockStatus = { computerId: "c1", status: "ready", provider: "e2b" };
    const { getByText, queryByText } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    expect(getByText(/isn't set up to run computers/i)).toBeTruthy();
    expect(queryByText("Open terminal")).toBeNull();
    // The computer itself still exists (it lives in Convex/E2B, not on this
    // server), so Delete must stay available.
    expect(getByText("Delete")).toBeTruthy();
  });

  it("aims the terminal at the remote data plane when delegating", () => {
    mockDataPlane = {
      localConfigured: false,
      remoteDataPlaneUrl: "https://dp.example.test",
    };
    mockStatus = { computerId: "c1", status: "ready", provider: "e2b" };
    const { getByText, getByTestId } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    fireEvent.click(getByText("Open terminal"));
    expect(getByTestId("terminal-stub").getAttribute("data-base-url")).toBe(
      "wss://dp.example.test"
    );
  });

  it("holds the terminal mount until the data-plane config resolves", () => {
    mockDataPlane = undefined; // /config still in flight
    mockStatus = { computerId: "c1", status: "ready", provider: "e2b" };
    const { getByText, queryByTestId, getByTestId, rerender } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    fireEvent.click(getByText("Open terminal"));
    // Mounting now would dial the page origin and never re-dial once the
    // remote base URL arrives — show a spinner instead.
    expect(queryByTestId("terminal-stub")).toBeNull();

    mockDataPlane = {
      localConfigured: false,
      remoteDataPlaneUrl: "https://dp.example.test",
    };
    rerender(<ComputerView projectId="p1" isAuthenticated />);
    expect(getByTestId("terminal-stub").getAttribute("data-base-url")).toBe(
      "wss://dp.example.test"
    );
  });

  it("keeps the terminal on the page origin when locally configured", () => {
    mockDataPlane = {
      localConfigured: true,
      // A remote URL alongside local credentials must be ignored.
      remoteDataPlaneUrl: "https://dp.example.test",
    };
    mockStatus = { computerId: "c1", status: "ready", provider: "e2b" };
    const { getByText, getByTestId } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    fireEvent.click(getByText("Open terminal"));
    expect(getByTestId("terminal-stub").getAttribute("data-base-url")).toBe("");
  });

  it("shows a 'no longer available' pane when the computer disappears with the terminal open", () => {
    mockStatus = { computerId: "c1", status: "ready", provider: "e2b" };
    const { getByText, queryByText, queryByTestId, rerender } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    fireEvent.click(getByText("Open terminal"));
    expect(queryByTestId("terminal-stub")).toBeTruthy();

    mockStatus = null; // removed out from under us (e.g. membership revoked)
    rerender(<ComputerView projectId="p1" isAuthenticated />);

    expect(queryByTestId("terminal-stub")).toBeNull();
    expect(queryByText(/Starting your computer/i)).toBeNull();
    expect(getByText(/no longer available/i)).toBeTruthy();
  });
});

describe("ComputerView usage meter", () => {
  it("shows awake time against the free allowance with the posted rate", () => {
    mockUsage = usage({ awakeMs: 4.2 * HOUR_MS });
    const { getByTestId, getByText } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    expect(getByTestId("computer-usage-meter")).toBeTruthy();
    expect(getByText("4.2 h")).toBeTruthy();
    expect(getByText(/of 30 h free/i)).toBeTruthy();
    expect(getByText(/then 10 credits\/hour/i)).toBeTruthy();
    expect(getByText(/sleeping is free/i)).toBeTruthy();
  });

  it("reads sub-hour usage in minutes", () => {
    mockUsage = usage({ awakeMs: 12 * 60 * 1000 });
    const { getByText } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    expect(getByText("12 min")).toBeTruthy();
  });

  it("surfaces charged credits once the allowance is exceeded", () => {
    mockUsage = usage({
      mode: "enforce",
      awakeMs: 31 * HOUR_MS,
      billedCredits: 10,
    });
    const { getByText, queryByText } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    expect(getByText("10 credits")).toBeTruthy();
    expect(queryByText(/^then /)).toBeNull();
  });

  it("says hours are included when the plan is uncapped", () => {
    mockUsage = usage({ allowanceMs: null, awakeMs: 2 * HOUR_MS });
    const { getByText, queryByText } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    expect(getByText(/included with your plan/i)).toBeTruthy();
    expect(queryByText(/credits\/hour/i)).toBeNull();
  });

  it("hides the meter when the backend is not metering or has no answer", () => {
    mockUsage = usage({ mode: "off" });
    const first = render(<ComputerView projectId="p1" isAuthenticated />);
    expect(first.queryByTestId("computer-usage-meter")).toBeNull();
    first.unmount();

    mockUsage = null;
    const second = render(<ComputerView projectId="p1" isAuthenticated />);
    expect(second.queryByTestId("computer-usage-meter")).toBeNull();
  });
});
