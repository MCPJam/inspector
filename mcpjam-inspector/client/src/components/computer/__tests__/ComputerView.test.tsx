import { render, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerView as ComputerViewModel } from "@/hooks/useProjectComputer";

const reserve = vi.fn(async () => ({} as never));
const deleteComputer = vi.fn(async () => ({ deleted: true }));
const mintToken = vi.fn(async () => ({ token: "t", expiresAt: 0 } as never));
let mockStatus: ComputerViewModel | null | undefined;
let mockDataPlane:
  | { localConfigured: boolean; remoteDataPlaneUrl: string | null }
  | undefined;

vi.mock("@/hooks/useProjectComputer", () => ({
  useComputerStatus: () => mockStatus,
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
  mockDataPlane = { localConfigured: true, remoteDataPlaneUrl: null };
});

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
