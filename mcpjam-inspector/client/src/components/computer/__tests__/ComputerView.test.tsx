import { render, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ComputerUsageView,
  ComputerView as ComputerViewModel,
} from "@/hooks/useProjectComputer";

const reserve = vi.fn(async () => ({} as never));
const deleteComputer = vi.fn(async () => ({ deleted: true }));
const hibernateComputer = vi.fn(async () => ({ hibernated: true }));
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
  useHibernateComputer: () => hibernateComputer,
  useMintTerminalToken: () => mintToken,
  useComputersDataPlaneConfig: () => mockDataPlane,
}));

let mockEnvironments: Array<{ environmentId: string; name: string }> = [];
const resetComputer = vi.fn(async () => ({ reset: true }));
vi.mock("@/hooks/useComputerEnvironments", () => ({
  useEnvironments: () => mockEnvironments,
  useResetComputer: () => resetComputer,
}));

// The drawer calls its own Convex hooks; stub it (its own tests cover it).
vi.mock("../EnvironmentsDrawer", () => ({
  EnvironmentsDrawer: ({ open }: { open: boolean }) =>
    open ? <div data-testid="env-drawer" /> : null,
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (sel: (s: { themeMode: string }) => unknown) =>
    sel({ themeMode: "dark" }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// The unauthenticated state now renders <GuestSignInMessage>, which reads the
// WorkOS + PostHog hooks. Stub both so the guest sign-in affordance mounts
// without an AuthKitProvider / PostHog provider.
const signInMock = vi.fn();
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ signIn: signInMock }),
}));
vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
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
  mockEnvironments = [];
  mockDataPlane = { localConfigured: true, remoteDataPlaneUrl: null };
  window.localStorage.clear();
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
  it("prompts to sign in when unauthenticated with an actionable Sign in button", () => {
    const { getByText, getByRole } = render(
      <ComputerView projectId="p1" isAuthenticated={false} />
    );
    // Honest one-liner naming why it's off for guests...
    expect(getByText(/Sign in to use a personal computer/i)).toBeTruthy();
    // ...and a working sign-in affordance, not a dead-end message.
    const button = getByRole("button", { name: /Sign in/i });
    fireEvent.click(button);
    expect(signInMock).toHaveBeenCalledTimes(1);
  });

  it("asks for a synced project when there is no projectId", () => {
    const { getByText } = render(
      <ComputerView projectId={null} isAuthenticated />
    );
    expect(getByText(/need a synced project/i)).toBeTruthy();
  });

  it("always shows the honest no-backup durability note", () => {
    mockStatus = { computerId: "c1", status: "ready", provider: "e2b" };
    const { getByText } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    expect(
      getByText(
        /Files persist when your computer sleeps, but they aren't backed up/i
      )
    ).toBeTruthy();
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
    expect(getByText(/Delete this computer\? All files on it will be deleted/i)).toBeTruthy();
    // The confirm button is the second "Delete" — click via the confirm row.
    fireEvent.click(getByText("Delete", { selector: "button" }));
    await waitFor(() =>
      expect(deleteComputer).toHaveBeenCalledWith({ projectId: "p1" })
    );
  });

  it("hibernate requires confirmation then calls hibernateComputer", async () => {
    mockStatus = { computerId: "c1", status: "ready", provider: "e2b" };
    const { getByText } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    fireEvent.click(getByText("Hibernate now"));
    expect(getByText("Hibernate now?")).toBeTruthy();
    // The confirm button is labelled just "Hibernate".
    fireEvent.click(getByText("Hibernate", { selector: "button" }));
    await waitFor(() =>
      expect(hibernateComputer).toHaveBeenCalledWith({ projectId: "p1" })
    );
  });

  it("does not offer Hibernate unless the computer is ready", () => {
    mockStatus = { computerId: "c1", status: "hibernating", provider: "e2b" };
    const { queryByText } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    expect(queryByText("Hibernate now")).toBeNull();
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
    expect(getByText(/Computers aren't available here/i)).toBeTruthy();
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

describe("ComputerView image strip", () => {
  it("shows the base image when no environment is attached", () => {
    mockStatus = { computerId: "c1", status: "ready", provider: "e2b" };
    const { getByText } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    expect(getByText("Base image")).toBeTruthy();
  });

  it("labels an attached env whose name hasn't resolved as a custom image, not base", () => {
    mockStatus = {
      computerId: "c1",
      status: "ready",
      provider: "e2b",
      environmentId: "envX",
    };
    mockEnvironments = []; // still loading / not visible to this caller
    const { getByText, queryByText } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    expect(getByText("Custom image")).toBeTruthy();
    expect(queryByText("Base image")).toBeNull();
  });

  it("shows the attached environment's name", () => {
    mockStatus = {
      computerId: "c1",
      status: "ready",
      provider: "e2b",
      environmentId: "env1",
    };
    mockEnvironments = [{ environmentId: "env1", name: "ml-toolkit" }];
    const { getByText } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    expect(getByText("ml-toolkit")).toBeTruthy();
  });

  it("Change opens the environments drawer", () => {
    mockStatus = { computerId: "c1", status: "ready", provider: "e2b" };
    const { getByText, queryByTestId, getByTestId } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    expect(queryByTestId("env-drawer")).toBeNull();
    fireEvent.click(getByText("Change"));
    expect(getByTestId("env-drawer")).toBeTruthy();
  });

  it("Reset confirms then resets the computer to its image", async () => {
    mockStatus = { computerId: "c1", status: "ready", provider: "e2b" };
    const { getByText } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    fireEvent.click(getByText("Reset"));
    expect(
      getByText(/All files on this computer will be deleted/i)
    ).toBeTruthy();
    fireEvent.click(getByText("Reset", { selector: "button" }));
    await waitFor(() =>
      expect(resetComputer).toHaveBeenCalledWith({ projectId: "p1" })
    );
  });

  it("disables Reset while the computer is mid-provision", () => {
    mockStatus = { computerId: "c1", status: "provisioning", provider: "e2b" };
    const { getByText } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    expect(
      (getByText("Reset", { selector: "button" }) as HTMLButtonElement).disabled
    ).toBe(true);
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

  it("shows a full over-limit bar for zero-allowance plans with usage", () => {
    mockUsage = usage({ allowanceMs: 0, awakeMs: 10 * 60 * 1000 });
    const { getByTestId } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    const fill = getByTestId("computer-usage-meter-fill");
    expect(fill.style.width).toBe("100%");
    expect(fill.className).toContain("bg-destructive");
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

describe("ComputerView billing-pause warning banner (COMP-7)", () => {
  it("shows the 80% warning banner when the backend signals it", () => {
    mockStatus = { computerId: "c1", status: "ready", provider: "e2b" };
    mockUsage = usage({ awakeMs: 24 * HOUR_MS, billingPauseWarning: true });
    const { getByTestId, getByText } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    expect(getByTestId("computer-billing-warning")).toBeTruthy();
    expect(
      getByText(/You've used 80% of your included compute hours/i)
    ).toBeTruthy();
    expect(
      getByText(/Files are preserved when your computer pauses/i)
    ).toBeTruthy();
    expect(getByText("Add credits")).toBeTruthy();
  });

  it("does not show the banner when the backend does not signal a warning", () => {
    mockStatus = { computerId: "c1", status: "ready", provider: "e2b" };
    mockUsage = usage({ awakeMs: 24 * HOUR_MS, billingPauseWarning: false });
    const { queryByTestId } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    expect(queryByTestId("computer-billing-warning")).toBeNull();
  });

  it("does not show the banner against a backend that omits the field", () => {
    mockStatus = { computerId: "c1", status: "ready", provider: "e2b" };
    // No billingPauseWarning key at all (older backend).
    mockUsage = usage({ awakeMs: 24 * HOUR_MS });
    const { queryByTestId } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    expect(queryByTestId("computer-billing-warning")).toBeNull();
  });

  it("dismisses the banner and keeps it hidden for the billing window", () => {
    mockStatus = { computerId: "c1", status: "ready", provider: "e2b" };
    mockUsage = usage({
      awakeMs: 24 * HOUR_MS,
      billingPauseWarning: true,
      windowStartAt: 1000,
    });
    const first = render(<ComputerView projectId="p1" isAuthenticated />);
    fireEvent.click(first.getByLabelText("Dismiss"));
    expect(first.queryByTestId("computer-billing-warning")).toBeNull();
    first.unmount();

    // A later mount in the same billing window stays dismissed (localStorage).
    const second = render(<ComputerView projectId="p1" isAuthenticated />);
    expect(second.queryByTestId("computer-billing-warning")).toBeNull();
  });

  it("re-appears in a new billing window even after a prior dismissal", () => {
    mockStatus = { computerId: "c1", status: "ready", provider: "e2b" };
    mockUsage = usage({
      awakeMs: 24 * HOUR_MS,
      billingPauseWarning: true,
      windowStartAt: 1000,
    });
    const first = render(<ComputerView projectId="p1" isAuthenticated />);
    fireEvent.click(first.getByLabelText("Dismiss"));
    first.unmount();

    // Next month → new windowStartAt → new dismissal key → banner returns.
    mockUsage = usage({
      awakeMs: 24 * HOUR_MS,
      billingPauseWarning: true,
      windowStartAt: 2000,
    });
    const second = render(<ComputerView projectId="p1" isAuthenticated />);
    expect(second.queryByTestId("computer-billing-warning")).toBeTruthy();
  });
});

describe("ComputerView post-hibernate billing state (COMP-7)", () => {
  it("shows a 'Paused for billing' state with the remedy, not a wake spinner", () => {
    mockStatus = {
      computerId: "c1",
      status: "hibernating",
      provider: "e2b",
      hibernatedReason: "billing",
    };
    const { getByTestId, queryByText } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    const notice = getByTestId("computer-paused-for-billing");
    // The status chip also reads "Paused for billing"; scope to the notice.
    expect(within(notice).getByText("Paused for billing")).toBeTruthy();
    expect(
      within(notice).getByText(/Files are preserved when your computer pauses/i)
    ).toBeTruthy();
    expect(within(notice).getByText("Add credits")).toBeTruthy();
    // Not the generic idle spinner.
    expect(queryByText(/Starting your computer/i)).toBeNull();
  });

  it("leaves idle hibernation messaging unchanged (no billing state)", () => {
    mockStatus = {
      computerId: "c1",
      status: "hibernating",
      provider: "e2b",
      hibernatedReason: "idle",
    };
    const { queryByTestId, queryByText } = render(
      <ComputerView projectId="p1" isAuthenticated />
    );
    expect(queryByTestId("computer-paused-for-billing")).toBeNull();
    expect(queryByText("Paused for billing")).toBeNull();
  });
});
