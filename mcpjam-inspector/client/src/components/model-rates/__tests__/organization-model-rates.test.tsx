import { getFunctionName } from "convex/server";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatDay,
  timeToDayInput,
  type ModelRateRow,
} from "../model-rate-format";
import { OrganizationModelRates } from "../organization-model-rates";
import { __resetListPricesForTests } from "../use-list-prices";

const flag = vi.hoisted(() => ({ on: true }));
vi.mock("@/hooks/useTraceCostEnabled", () => ({
  useTraceCostEnabled: () => flag.on,
}));
vi.mock("@/lib/error-reporting", () => ({ reportBoundaryError: vi.fn() }));
vi.mock("@/lib/convex-site-url", () => ({
  getConvexSiteUrl: () => "https://site.example",
}));
const convex = vi.hoisted(() => ({
  queries: new Map<string, unknown>(),
  throws: null as Error | null,
  set: vi.fn(async (_args: unknown) => ({ rateId: "r2", revision: 2 })),
  retire: vi.fn(async (_args: unknown) => ({ rateId: "r1", retiredAt: 1 })),
}));
vi.mock("convex/react", () => ({
  useQuery: vi.fn((query: Parameters<typeof getFunctionName>[0]) => {
    if (convex.throws) throw convex.throws;
    return convex.queries.get(getFunctionName(query));
  }),
  useQueries: (queries: Record<string, { query: never }>) =>
    Object.fromEntries(
      Object.entries(queries).map(([key, { query }]) => [
        key,
        convex.queries.get(getFunctionName(query)),
      ]),
    ),
  useMutation: (mutation: Parameters<typeof getFunctionName>[0]) =>
    getFunctionName(mutation) === "organizationModelRates:set"
      ? convex.set
      : convex.retire,
}));

const sonnet: ModelRateRow = {
  rateId: "r1",
  modelId: "anthropic/claude-sonnet-4.5",
  rates: { currency: "USD", input: 2.4, output: 12, cacheRead: 0.24 },
  effectiveAt: Date.UTC(2026, 9, 1),
  revision: 1,
  createdBy: { name: "Ada Admin" },
};

const DAY = 24 * 60 * 60 * 1000;
const scheduled: ModelRateRow = {
  ...sonnet,
  rateId: "r2",
  rates: { currency: "USD", input: 2, output: 10 },
  effectiveAt: Date.now() + 30 * DAY,
  revision: 2,
};

const providers = [
  {
    providerKey: "anthropic",
    displayName: "Anthropic",
    enabled: true,
    hasSecret: true,
  },
];

function mount(isAdmin: boolean) {
  return render(
    <OrganizationModelRates
      organizationId="org_1"
      isAdmin={isAdmin}
      providers={providers}
    />,
  );
}

describe("OrganizationModelRates", () => {
  beforeEach(() => {
    __resetListPricesForTests();
    convex.queries.set("organizationModelRates:list", [sonnet]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        prices: [
          {
            modelId: "anthropic/claude-sonnet-4.5",
            rates: { currency: "USD", input: 3, output: 15, cacheRead: 0.3 },
          },
        ],
      }),
    );
  });

  afterEach(() => {
    cleanup();
    flag.on = true;
    convex.throws = null;
    convex.queries.clear();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("shows each rate with its author and revision, and the list price beside it", async () => {
    mount(false);
    const panel = screen.getByTestId("model-rates-panel");
    expect(within(panel).getByText("Model prices")).toBeTruthy();
    const row = within(panel)
      .getByText("anthropic/claude-sonnet-4.5")
      .closest("tr")!;
    expect(row).toHaveTextContent("$2.4");
    expect(row).toHaveTextContent("$12");
    expect(row).toHaveTextContent("Not set");
    expect(row).toHaveTextContent("Ada Admin");
    expect(row).toHaveTextContent("Any provider");
    await waitFor(() =>
      expect(row).toHaveTextContent(
        "List price: $3 input, $15 output, $0.3 cache read per 1M tokens",
      ),
    );
  });

  it("gives members the list and its history but no edit controls", () => {
    convex.queries.set("organizationModelRates:history", [sonnet]);
    mount(false);
    expect(screen.queryByRole("button", { name: /Add price/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Retire/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /History/ }));
    expect(
      screen.getByText("Price history for anthropic/claude-sonnet-4.5"),
    ).toBeTruthy();
    // A long history scrolls inside the dialog instead of past the viewport.
    expect(screen.getByRole("dialog")).toHaveClass(
      "max-h-[85vh]",
      "overflow-y-auto",
    );
  });

  it("lets an admin save a new revision and retire a rate", async () => {
    mount(true);
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    fireEvent.change(screen.getByLabelText("Output price"), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save price" }));
    await waitFor(() => expect(convex.set).toHaveBeenCalledTimes(1));
    expect(convex.set.mock.calls[0]![0]).toMatchObject({
      organizationId: "org_1",
      modelId: "anthropic/claude-sonnet-4.5",
      rates: { currency: "USD", input: 2.4, output: 10, cacheRead: 0.24 },
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Retire anthropic/claude-sonnet-4.5",
      }),
    );
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Retire",
      }),
    );
    await waitFor(() =>
      expect(convex.retire).toHaveBeenCalledWith({
        organizationId: "org_1",
        rateId: "r1",
      }),
    );
  });

  it("retires once when the confirm button is pressed twice", async () => {
    let finish!: () => void;
    convex.retire.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ rateId: "r1", retiredAt: 1 });
        }),
    );
    mount(true);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Retire anthropic/claude-sonnet-4.5",
      }),
    );
    const dialog = within(screen.getByRole("alertdialog"));
    fireEvent.click(dialog.getByRole("button", { name: "Retire" }));
    const busy = await dialog.findByRole("button", { name: "Retiring..." });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    finish();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(convex.retire).toHaveBeenCalledTimes(1);
  });

  it("shows the price in force today beside a scheduled one", () => {
    convex.queries.set("organizationModelRates:list", [scheduled]);
    convex.queries.set("organizationModelRates:history", [scheduled, sonnet]);
    mount(false);
    const until = formatDay(scheduled.effectiveAt);
    const row = screen.getByText(`In force until ${until}`).closest("tr")!;
    expect(row).toHaveTextContent("$2.4");
    expect(row).toHaveTextContent("$12");
    expect(row).toHaveTextContent(formatDay(sonnet.effectiveAt));
    expect(
      screen.getByText("anthropic/claude-sonnet-4.5").closest("tr"),
    ).toHaveTextContent("Scheduled");
  });

  it("moves the in-force row to the next scheduled revision when it starts", async () => {
    const MINUTE = 60_000;
    const start = Date.UTC(2026, 10, 17, 12);
    vi.useFakeTimers({ now: start });
    try {
      const next: ModelRateRow = {
        ...sonnet,
        rateId: "r4",
        rates: { currency: "USD", input: 5, output: 15 },
        effectiveAt: start + MINUTE,
        revision: 2,
      };
      const newest: ModelRateRow = {
        ...sonnet,
        rateId: "r5",
        rates: { currency: "USD", input: 9, output: 20 },
        effectiveAt: start + 2 * MINUTE,
        revision: 3,
      };
      convex.queries.set("organizationModelRates:list", [newest]);
      convex.queries.set("organizationModelRates:history", [
        newest,
        next,
        sonnet,
      ]);
      mount(false);
      const inForceRow = () =>
        screen.getByText(/^In force until/).closest("tr")!;
      expect(inForceRow()).toHaveTextContent("$2.4");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(MINUTE + 1);
      });
      expect(inForceRow()).toHaveTextContent("$5");
      expect(inForceRow()).not.toHaveTextContent("$2.4");
    } finally {
      vi.useRealTimers();
    }
  });

  it("dates the in-force row by the next revision to start, not the newest", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const next: ModelRateRow = {
      ...sonnet,
      rateId: "r6",
      rates: { currency: "USD", input: 5, output: 15 },
      effectiveAt: Date.now() + DAY,
      revision: 2,
    };
    const newest: ModelRateRow = {
      ...sonnet,
      rateId: "r7",
      rates: { currency: "USD", input: 9, output: 20 },
      effectiveAt: Date.now() + 3 * DAY,
      revision: 3,
    };
    convex.queries.set("organizationModelRates:list", [newest]);
    convex.queries.set("organizationModelRates:history", [
      newest,
      next,
      sonnet,
    ]);
    mount(false);
    const row = screen.getByText(/^In force until/).closest("tr")!;
    expect(row).toHaveTextContent(
      `In force until ${formatDay(next.effectiveAt)}`,
    );
    expect(row).toHaveTextContent("$2.4");
  });

  it("says no price is in force before a first scheduled price", () => {
    convex.queries.set("organizationModelRates:list", [scheduled]);
    convex.queries.set("organizationModelRates:history", [scheduled]);
    mount(false);
    expect(
      screen.getByText(
        `No price in force until ${formatDay(scheduled.effectiveAt)}.`,
      ),
    ).toBeTruthy();
  });

  it("keeps a scheduled price's date when an admin edits it", async () => {
    convex.queries.set("organizationModelRates:list", [scheduled]);
    convex.queries.set("organizationModelRates:history", [scheduled, sonnet]);
    mount(true);
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    expect(screen.getByLabelText("Effective date")).toHaveValue(
      timeToDayInput(scheduled.effectiveAt),
    );
    fireEvent.change(screen.getByLabelText("Output price"), {
      target: { value: "9" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save price" }));
    await waitFor(() => expect(convex.set).toHaveBeenCalledTimes(1));
    expect(convex.set.mock.calls[0]![0]).toMatchObject({
      rates: { input: 2, output: 9 },
      effectiveAt: scheduled.effectiveAt,
    });
  });

  it("says long-context prices are kept and keeps them on save", async () => {
    const tiers = [{ aboveInputTokens: 200_000, input: 6, output: 22.5 }];
    convex.queries.set("organizationModelRates:list", [
      { ...sonnet, rates: { ...sonnet.rates, tiers } },
    ]);
    mount(true);
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    expect(
      screen.getByText(
        "Saving keeps the long-context prices for calls above 200,000 input tokens. To remove them, retire this price and add it again.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save price" }));
    await waitFor(() => expect(convex.set).toHaveBeenCalledTimes(1));
    expect(convex.set.mock.calls[0]![0]).toMatchObject({ rates: { tiers } });
  });

  it("shows the backend's refusal in the form and keeps it open", async () => {
    convex.set.mockRejectedValueOnce(
      new Error(
        "Only organization admins can change model rates. Ask an admin to make the change.",
      ),
    );
    mount(true);
    fireEvent.click(screen.getByRole("button", { name: /Add price/ }));
    fireEvent.change(screen.getByLabelText("Model ID"), {
      target: { value: "openai/gpt-5-mini" },
    });
    fireEvent.change(screen.getByLabelText("Input price"), {
      target: { value: "0.2" },
    });
    fireEvent.change(screen.getByLabelText("Output price"), {
      target: { value: "1.6" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save price" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only organization admins can change model rates.",
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("renders nothing on a backend that does not serve organization rates", () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    convex.throws = new Error(
      "[CONVEX Q(organizationModelRates:list)] Could not find public function for 'organizationModelRates:list'",
    );
    const { container } = mount(true);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when production redacts the missing query", () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    convex.throws = new Error(
      "[CONVEX Q(organizationModelRates:list)] [Request ID: da0bbc6cf9261481] Server Error",
    );
    const { container } = mount(true);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing and reads nothing with the flag off", async () => {
    flag.on = false;
    const { container } = mount(true);
    expect(container).toBeEmptyDOMElement();
    const { useQuery } = await import("convex/react");
    expect(useQuery).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
