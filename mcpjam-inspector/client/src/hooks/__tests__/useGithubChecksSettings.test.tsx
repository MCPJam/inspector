import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { value: null as { id: string } | null },
  isAuthenticated: { value: true },
  isUserReady: { value: true },
  useQuery: vi.fn(),
  reportBoundaryError: vi.fn(),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: mocks.user.value, isLoading: false }),
}));

vi.mock("convex/react", () => ({
  useAction: () => vi.fn(),
  useMutation: () => vi.fn(),
  useConvexAuth: () => ({
    isAuthenticated: mocks.isAuthenticated.value,
    isLoading: false,
  }),
  useQuery: (name: unknown, args: unknown) => mocks.useQuery(name, args),
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => mocks.isUserReady.value,
}));

vi.mock("@/lib/error-reporting", () => ({
  reportBoundaryError: (...args: unknown[]) =>
    mocks.reportBoundaryError(...args),
}));

import { ErrorBoundary } from "@/components/ui/error-boundary";
import { ConvexError } from "convex/values";
import { useGithubChecksAvailability } from "../useGithubChecksSettings";

function AvailabilityProbe({
  organizationId,
}: {
  organizationId: string | null | undefined;
}) {
  const availability = useGithubChecksAvailability(organizationId);
  return <div>{availability?.state ?? "unavailable"}</div>;
}

function renderProbe(organizationId: string | null | undefined = "org-1") {
  return render(
    <ErrorBoundary name="integrations_github_checks" fallback={null}>
      <AvailabilityProbe organizationId={organizationId} />
    </ErrorBoundary>
  );
}

describe("useGithubChecksAvailability", () => {
  beforeEach(() => {
    mocks.user.value = null;
    mocks.isAuthenticated.value = true;
    mocks.isUserReady.value = true;
    vi.clearAllMocks();
    mocks.useQuery.mockImplementation((_name: unknown, args: unknown) => {
      if (args !== "skip") {
        throw new Error(
          "[CONVEX Q(github/checkRepoConfigs:getGithubChecksSettingsAvailability)] Server Error"
        );
      }
      return undefined;
    });
  });

  it("does not query or report when the Convex-authenticated actor is a guest", () => {
    renderProbe();

    expect(screen.getByText("unavailable")).toBeInTheDocument();
    expect(mocks.useQuery).toHaveBeenCalledWith(
      "github/checkRepoConfigs:getGithubChecksSettingsAvailability",
      "skip"
    );
    expect(mocks.reportBoundaryError).not.toHaveBeenCalled();
  });

  it.each([
    ["an unauthenticated session", false, true, "org-1"],
    ["an unready user", true, false, "org-1"],
    ["a null organization id", true, true, null],
    ["an empty organization id", true, true, ""],
  ] as const)(
    "skips the query and reporting for %s",
    (_state, isAuthenticated, isUserReady, organizationId) => {
      mocks.user.value = { id: "user-1" };
      mocks.isAuthenticated.value = isAuthenticated;
      mocks.isUserReady.value = isUserReady;

      renderProbe(organizationId);

      expect(screen.getByText("unavailable")).toBeInTheDocument();
      expect(mocks.useQuery).toHaveBeenCalledWith(
        "github/checkRepoConfigs:getGithubChecksSettingsAvailability",
        "skip"
      );
      expect(mocks.reportBoundaryError).not.toHaveBeenCalled();
    }
  );

  it("still asks the backend for a signed-in WorkOS user", () => {
    mocks.user.value = { id: "user-1" };
    mocks.useQuery.mockReturnValue({ state: "enabled" });

    renderProbe();

    expect(screen.getByText("enabled")).toBeInTheDocument();
    expect(mocks.useQuery).toHaveBeenCalledWith(
      "github/checkRepoConfigs:getGithubChecksSettingsAvailability",
      { organizationId: "org-1" }
    );
  });

  it("contains a signed-in membership refusal in the error boundary", () => {
    mocks.user.value = { id: "user-1" };
    const refusal = new ConvexError({
      kind: "forbidden",
      message: "Not a member of this organization",
    });
    mocks.useQuery.mockImplementation(() => {
      throw refusal;
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    try {
      const { container } = renderProbe();

      expect(container).toBeEmptyDOMElement();
      expect(mocks.useQuery).toHaveBeenCalledWith(
        "github/checkRepoConfigs:getGithubChecksSettingsAvailability",
        { organizationId: "org-1" }
      );
      expect(mocks.reportBoundaryError).toHaveBeenCalledTimes(1);
      expect(mocks.reportBoundaryError.mock.calls[0]?.[0]).toBe(refusal);
      expect(mocks.reportBoundaryError.mock.calls[0]?.[2]).toBe(
        "integrations_github_checks"
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
