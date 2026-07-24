/**
 * New-journey form ENV MODE (Project Environments — B5): flag-gated toggle,
 * ordered env multi-select, and the create payload invariant — env submits
 * send `environmentIds` + compat `hostIds` recomputed from the selected
 * environments (deduped, in order) and OMIT `serverAttachmentId`.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));

// Flag ON for this suite (the sibling journeyForm suite runs with it off).
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => true,
}));

const persona = {
  _id: "persona-1",
  personaId: "p1",
  name: "Persona One",
  role: "tester",
  notes: "",
};
const host = {
  hostId: "host-1",
  name: "Host One",
  modelId: "openai/gpt-4o-mini",
  ownerScope: { type: "journeys" },
};
const hostTwo = {
  hostId: "host-2",
  name: "Host Two",
  modelId: "anthropic/claude-haiku-4.5",
  ownerScope: { type: "journeys" },
};
const environments = [
  {
    environmentId: "env-1",
    projectId: "proj-1",
    name: "Prod-like",
    hostId: "host-1",
    revision: 1,
  },
  {
    environmentId: "env-2",
    projectId: "proj-1",
    name: "Staging-like",
    hostId: "host-2",
    revision: 3,
  },
  {
    environmentId: "env-3",
    projectId: "proj-1",
    name: "Same host as Prod",
    hostId: "host-1",
    revision: 2,
  },
];

const { createJourneyMutation } = vi.hoisted(() => ({
  createJourneyMutation: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    if (args === "skip") return undefined;
    switch (name) {
      case "personas:listPersonas":
        return [persona];
      case "journeys:listJourneysByPersona":
        return [];
      case "hosts:listHosts":
        return [host, hostTwo];
      case "projectEnvironments:listEnvironments":
        return environments;
      default:
        return undefined;
    }
  },
  useMutation: (name: string) => {
    if (name === "journeys:createJourney") return createJourneyMutation;
    return vi.fn().mockResolvedValue(undefined);
  },
  usePaginatedQuery: () => ({
    results: [],
    status: "Exhausted",
    loadMore: vi.fn(),
    isLoading: false,
  }),
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => ({
    serverAttachments: [],
    isLoading: false,
  }),
  useProjectServers: () => ({ servers: [], isLoading: false }),
  useDbUserReady: () => true,
}));

vi.mock("@/components/hosts/ServerGroupPicker", () => ({
  ServerGroupPicker: () => (
    <button type="button" data-testid="mock-server-group-picker">
      No server group · pick one
    </button>
  ),
}));

vi.mock("@/components/connection/share-usage/ShareUsageThreadDetail", () => ({
  ShareUsageThreadDetail: () => null,
}));
vi.mock("@/lib/chatbox-session", () => ({
  getShareableAppOrigin: () => "https://app.test",
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { SwarmsTab } from "../SwarmsTab";

beforeEach(() => {
  vi.clearAllMocks();
  createJourneyMutation.mockResolvedValue({ _id: "journey-new" });
});

function openForm() {
  fireEvent.click(screen.getByText("Persona One"));
  fireEvent.click(screen.getByRole("button", { name: /new journey/i }));
}

async function pickEnvironment(name: string | RegExp) {
  fireEvent.click(screen.getByTestId("journey-environments-picker"));
  fireEvent.click(await screen.findByRole("checkbox", { name }));
}

describe("SwarmsTab — new journey form env mode", () => {
  it("shows the mode toggle when the flag is on and gates Create on ≥1 environment", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openForm();

    fireEvent.click(screen.getByTestId("journey-target-mode-environments"));
    fireEvent.change(screen.getByLabelText("Goal"), {
      target: { value: "Draw a dog" },
    });
    const createBtn = screen.getByRole("button", { name: /create journey/i });
    expect(createBtn).toBeDisabled();

    await pickEnvironment(/prod-like/i);
    expect(createBtn).not.toBeDisabled();
  });

  it("env submit: environmentIds in selection order + compat hostIds deduped in order, NO serverAttachmentId", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openForm();

    fireEvent.click(screen.getByTestId("journey-target-mode-environments"));
    fireEvent.change(screen.getByLabelText("Goal"), {
      target: { value: "Draw a dog" },
    });
    // Selection order: Staging-like (host-2), Prod-like (host-1),
    // Same host as Prod (host-1 again → deduped).
    fireEvent.click(screen.getByTestId("journey-environments-picker"));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /staging-like/i }),
    );
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /prod-like/i }),
    );
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /same host as prod/i }),
    );

    fireEvent.click(screen.getByRole("button", { name: /create journey/i }));

    await waitFor(() => {
      expect(createJourneyMutation).toHaveBeenCalledTimes(1);
    });
    const payload = createJourneyMutation.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(payload.environmentIds).toEqual(["env-2", "env-1", "env-3"]);
    // Compat hostIds recomputed from the envs: deduped, in selection order.
    expect(payload.hostIds).toEqual(["host-2", "host-1"]);
    expect("serverAttachmentId" in payload).toBe(false);
  });

  it("clients mode stays byte-compatible (no environmentIds in the payload)", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    openForm();
    // Default mode is Clients; env state must not leak into the payload.
    expect(
      screen.getByTestId("journey-target-mode-clients"),
    ).toHaveAttribute("aria-checked", "true");
  });
});
