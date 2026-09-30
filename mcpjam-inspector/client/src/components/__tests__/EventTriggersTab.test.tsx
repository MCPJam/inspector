/**
 * The Triggers tab: hosted-only trigger configuration (Convex) and run
 * history, including the parked state (`tool_outcome_unknown`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

const queryResults = new Map<unknown, unknown>();
const mutations = new Map<unknown, ReturnType<typeof vi.fn>>();
const mockTrack = vi.fn();

vi.mock("convex/react", () => ({
  useQuery: (ref: unknown, args: unknown) =>
    args === "skip" ? undefined : queryResults.get(ref),
  useMutation: (ref: unknown) => {
    if (!mutations.has(ref)) mutations.set(ref, vi.fn());
    return mutations.get(ref);
  },
}));

vi.mock("@/lib/analytics", () => ({
  track: (...args: unknown[]) => mockTrack(...args),
}));

import { EventTriggersTab, PARKED_EXPLANATION } from "../EventTriggersTab";
import { EVENT_SUBSCRIPTIONS_API } from "@/lib/apis/mcp-events-api";
import {
  EVENT_TRIGGER_RUNS_API,
  EVENT_TRIGGERS_API,
} from "@/lib/apis/event-triggers-api";

const subscription = {
  _id: "sub_1",
  logicalId: "esub_1",
  projectId: "proj_1",
  binding: { serverId: "srv_1" },
  locality: "hosted",
  profile: "draft@28ec35e",
  eventName: "issue.created",
  arguments: {},
  mode: "webhook",
  desiredState: "active",
  observedState: "active",
  generation: 1,
  consecutiveFailures: 0,
};

const trigger = {
  _id: "trg_1",
  projectId: "proj_1",
  subscriptionId: "sub_1",
  name: "Triage new issues",
  instructions: "Label the issue.",
  enabled: true,
  revision: 1,
  approvalPolicy: "deny_writes",
  maxSteps: 8,
  rateLimitPerHour: 30,
  spendCapMicrosPerDay: 2_000_000,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const parkedRun = {
  _id: "run_1",
  triggerId: "trg_1",
  subscriptionId: "sub_1",
  namespace: "simulation",
  eventId: "evt_9",
  status: "parked",
  parkedReason: "tool_outcome_unknown",
  error: "tool_outcome_unknown",
  createdAt: Date.now(),
};

describe("EventTriggersTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResults.clear();
    mutations.clear();
    queryResults.set(EVENT_SUBSCRIPTIONS_API.list, [
      subscription,
      // A local subscription is never delivered to the hosted runner.
      {
        ...subscription,
        _id: "sub_local",
        locality: "local",
        eventName: "local.only",
      },
    ]);
  });

  it("explains that triggers need a signed-in hosted project", () => {
    render(<EventTriggersTab projectId={null} isSignedInMember={false} />);
    expect(
      screen.getByText("Triggers run on MCPJam's hosted runner"),
    ).toBeInTheDocument();
    expect(mockTrack).toHaveBeenCalledWith("triggers_tab_viewed", {
      location: "triggers_tab",
    });
  });

  it("creates a trigger, converting the daily spend cap to micros", async () => {
    queryResults.set(EVENT_TRIGGERS_API.list, []);
    const create = vi.fn().mockResolvedValue("trg_new");
    mutations.set(EVENT_TRIGGERS_API.create, create);
    render(<EventTriggersTab projectId="proj_1" isSignedInMember />);

    fireEvent.click(screen.getAllByRole("button", { name: /New trigger/ })[0]!);
    const form = await screen.findByTestId("trigger-form");
    const picker = within(form).getByLabelText(
      "Subscription",
    ) as HTMLSelectElement;
    expect(Array.from(picker.options).map((option) => option.value)).toEqual([
      "sub_1",
    ]);

    fireEvent.change(within(form).getByLabelText("Name"), {
      target: { value: "Triage" },
    });
    fireEvent.change(within(form).getByLabelText("Instructions"), {
      target: { value: "Label each new issue." },
    });
    fireEvent.change(within(form).getByLabelText("Daily spend cap ($)"), {
      target: { value: "1.5" },
    });
    fireEvent.change(within(form).getByLabelText("Runs per hour"), {
      target: { value: "12" },
    });

    fireEvent.click(
      within(form).getByRole("button", { name: "Create trigger" }),
    );

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith({
      projectId: "proj_1",
      subscriptionId: "sub_1",
      name: "Triage",
      instructions: "Label each new issue.",
      maxSteps: 8,
      rateLimitPerHour: 12,
      spendCapMicrosPerDay: 1_500_000,
      approvalPolicy: "deny_writes",
    });
  });

  it("refuses an out-of-range budget before calling the backend", async () => {
    queryResults.set(EVENT_TRIGGERS_API.list, []);
    render(<EventTriggersTab projectId="proj_1" isSignedInMember />);

    fireEvent.click(screen.getAllByRole("button", { name: /New trigger/ })[0]!);
    const form = await screen.findByTestId("trigger-form");
    fireEvent.change(within(form).getByLabelText("Name"), {
      target: { value: "Triage" },
    });
    fireEvent.change(within(form).getByLabelText("Instructions"), {
      target: { value: "Do it." },
    });
    fireEvent.change(within(form).getByLabelText("Max steps"), {
      target: { value: "99" },
    });
    fireEvent.click(
      within(form).getByRole("button", { name: "Create trigger" }),
    );

    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "Max steps must be a whole number from 1 to 32.",
    );
    expect(mutations.get(EVENT_TRIGGERS_API.create)).not.toHaveBeenCalled();
  });

  it("shows run history with the parked reason, and the run's frozen input", async () => {
    queryResults.set(EVENT_TRIGGERS_API.list, [trigger]);
    queryResults.set(EVENT_TRIGGER_RUNS_API.listForTrigger, [parkedRun]);
    queryResults.set(EVENT_TRIGGER_RUNS_API.get, {
      run: parkedRun,
      input: {
        trigger: { id: "trg_1", revision: 1, instructions: "Label the issue." },
        event: {
          eventId: "evt_9",
          name: "issue.created",
          namespace: "simulation",
          data: { title: "<img src=x onerror=alert(1)>" },
        },
      },
      messages: null,
      result: null,
      calls: [
        {
          callId: "call_1",
          operation: "github.add_label",
          status: "pending",
          replayable: false,
        },
      ],
    });
    const { container } = render(
      <EventTriggersTab projectId="proj_1" isSignedInMember />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Triage new issues/ }));
    const history = await screen.findByTestId("run-history");
    expect(within(history).getByText("parked")).toBeInTheDocument();
    expect(within(history).getByText("simulation")).toBeInTheDocument();
    expect(within(history).getByText("evt_9")).toBeInTheDocument();
    expect(
      within(history).getByText("tool_outcome_unknown"),
    ).toBeInTheDocument();
    expect(history).toHaveTextContent(PARKED_EXPLANATION);

    fireEvent.click(within(history).getByRole("button"));
    const detail = await screen.findByTestId("run-detail");
    expect(detail).toHaveTextContent("MCPJam never repeats an unknown write");
    expect(within(detail).getByText("github.add_label")).toBeInTheDocument();
    expect(within(detail).getByText("outcome unknown")).toBeInTheDocument();
    // Event data is untrusted: text, never markup.
    expect(within(detail).getByTestId("event-data")).toHaveTextContent(
      "<img src=x onerror=alert(1)>",
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("toggles a trigger off through setEnabled", async () => {
    queryResults.set(EVENT_TRIGGERS_API.list, [trigger]);
    queryResults.set(EVENT_TRIGGER_RUNS_API.listForTrigger, []);
    render(<EventTriggersTab projectId="proj_1" isSignedInMember />);

    fireEvent.click(screen.getByRole("button", { name: /Triage new issues/ }));
    fireEvent.click(await screen.findByRole("switch"));
    await waitFor(() =>
      expect(mutations.get(EVENT_TRIGGERS_API.setEnabled)).toHaveBeenCalledWith(
        {
          triggerId: "trg_1",
          enabled: false,
        },
      ),
    );
  });
});
