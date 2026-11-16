import { getFunctionName } from "convex/server";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRateRow } from "../model-rate-format";
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
    expect(screen.queryByRole("button", { name: "Retire" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /History/ }));
    expect(
      screen.getByText("Price history for anthropic/claude-sonnet-4.5"),
    ).toBeTruthy();
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

    fireEvent.click(screen.getByRole("button", { name: "Retire" }));
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
