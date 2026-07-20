/**
 * New-journey form: requires a server group + hostIds, passes serverAttachmentId.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { createJourneyMutation, serverGroupPickerState } = vi.hoisted(() => ({
  createJourneyMutation: vi.fn(),
  serverGroupPickerState: {
    onChange: null as null | ((id: string) => void),
  },
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
        return [host];
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
    serverAttachments: [
      {
        _id: "att-1",
        name: "group 1",
        serverIds: ["srv-1"],
        resolvedServerNames: ["alpha"],
      },
    ],
    isLoading: false,
  }),
  useProjectServers: () => ({ servers: [], isLoading: false }),
  useDbUserReady: () => true,
}));

vi.mock("@/components/hosts/ServerGroupPicker", () => ({
  ServerGroupPicker: ({
    value,
    onChange,
  }: {
    value: string | null;
    onChange: (id: string) => void;
  }) => {
    serverGroupPickerState.onChange = onChange;
    return (
      <button
        type="button"
        data-testid="mock-server-group-picker"
        onClick={() => onChange("att-1")}
      >
        {value ? `Selected ${value}` : "No server group · pick one"}
      </button>
    );
  },
}));

vi.mock("@/lib/swarm-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/swarm-api")>();
  return {
    ...actual,
    launchJourneyRun: vi.fn(),
  };
});

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
  serverGroupPickerState.onChange = null;
});

async function pickClient(name: string | RegExp) {
  fireEvent.click(screen.getByRole("button", { name: /attached clients/i }));
  fireEvent.click(await screen.findByRole("button", { name }));
}

describe("SwarmsTab — new journey form server group", () => {
  it("keeps Create disabled until a server group and client are picked", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    fireEvent.click(screen.getByText("Persona One"));
    fireEvent.click(screen.getByRole("button", { name: /new journey/i }));

    const createBtn = screen.getByRole("button", { name: /create journey/i });
    expect(createBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Goal"), {
      target: { value: "Draw a dog" },
    });
    expect(createBtn).toBeDisabled();

    await pickClient(/host one/i);
    expect(createBtn).toBeDisabled();

    fireEvent.click(screen.getByTestId("mock-server-group-picker"));
    expect(createBtn).not.toBeDisabled();
  });

  it("passes serverAttachmentId into createJourney", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);
    fireEvent.click(screen.getByText("Persona One"));
    fireEvent.click(screen.getByRole("button", { name: /new journey/i }));

    fireEvent.change(screen.getByLabelText("Goal"), {
      target: { value: "Draw a dog" },
    });
    await pickClient(/host one/i);
    fireEvent.click(screen.getByTestId("mock-server-group-picker"));
    fireEvent.click(screen.getByRole("button", { name: /create journey/i }));

    await waitFor(() => {
      expect(createJourneyMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "proj-1",
          personaRefId: "persona-1",
          goal: "Draw a dog",
          hostIds: ["host-1"],
          serverAttachmentId: "att-1",
          config: { sessionsPerHost: 2, maxTurns: 6 },
        }),
      );
    });
  });
});
