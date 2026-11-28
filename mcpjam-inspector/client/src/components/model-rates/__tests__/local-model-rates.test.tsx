import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalModelRates } from "../local-model-rates";
import { formatDay } from "../model-rate-format";
import { __resetListPricesForTests } from "../use-list-prices";

const flag = vi.hoisted(() => ({ on: true }));
vi.mock("@/hooks/useTraceCostEnabled", () => ({
  useTraceCostEnabled: () => flag.on,
}));
vi.mock("@/lib/convex-site-url", () => ({ getConvexSiteUrl: () => null }));
const server = vi.hoisted(() => ({
  authFetch: vi.fn(),
  rates: [] as unknown[],
  revisions: [] as unknown[],
}));
vi.mock("@/lib/session-token", () => ({ authFetch: server.authFetch }));

const llama = {
  rateId: "r1",
  providerKey: "ollama",
  modelId: "llama3.2",
  rates: { currency: "USD", input: 0.1, output: 0.2 },
  effectiveAt: Date.UTC(2026, 9, 1),
  revision: 1,
  createdAt: Date.UTC(2026, 9, 1),
};

const DAY = 24 * 60 * 60 * 1000;
const scheduled = {
  ...llama,
  rateId: "r2",
  rates: { currency: "USD", input: 0.3, output: 0.6 },
  effectiveAt: Date.now() + 30 * DAY,
  revision: 2,
};

describe("LocalModelRates", () => {
  beforeEach(() => {
    __resetListPricesForTests();
    server.rates = [llama];
    server.revisions = [];
    server.authFetch.mockImplementation(
      async (url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? Response.json({ ok: true, rate: llama })
          : url.includes("?")
            ? Response.json({ ok: true, revisions: server.revisions })
            : Response.json({ ok: true, rates: server.rates }),
    );
  });

  afterEach(() => {
    cleanup();
    flag.on = true;
    vi.clearAllMocks();
  });

  it("says the prices stay on this machine and lists them", async () => {
    render(<LocalModelRates />);
    expect(screen.getByText("Model prices on this machine")).toBeTruthy();
    expect(
      screen.getByText(/Stored on this machine only and never uploaded/),
    ).toBeTruthy();
    expect(await screen.findByText("llama3.2")).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
    expect(server.authFetch).toHaveBeenCalledWith(
      "/api/mcp/model-rate-overrides",
      undefined,
    );
  });

  it("refuses a price without a provider before sending anything", async () => {
    render(<LocalModelRates />);
    await screen.findByText("llama3.2");
    fireEvent.click(screen.getByRole("button", { name: /Add price/ }));
    fireEvent.change(screen.getByLabelText("Model ID"), {
      target: { value: "qwen3" },
    });
    fireEvent.change(screen.getByLabelText("Input price"), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByLabelText("Output price"), {
      target: { value: "-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save price" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Pick the provider these prices apply to.",
    );
    expect(server.authFetch).toHaveBeenCalledTimes(1);
  });

  it("saves a new revision to the local server and reloads", async () => {
    render(<LocalModelRates />);
    await screen.findByText("llama3.2");
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    fireEvent.change(screen.getByLabelText("Input price"), {
      target: { value: "abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save price" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Input price must be zero or more. Enter a dollar amount.",
    );

    fireEvent.change(screen.getByLabelText("Input price"), {
      target: { value: "0.15" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save price" }));
    await waitFor(() => expect(server.authFetch).toHaveBeenCalledTimes(3));
    const [url, init] = server.authFetch.mock.calls[1]!;
    expect(url).toBe("/api/mcp/model-rate-overrides");
    expect(JSON.parse(init.body)).toMatchObject({
      providerKey: "ollama",
      modelId: "llama3.2",
      rates: { currency: "USD", input: 0.15, output: 0.2 },
    });
  });

  it("says what failed when the local server cannot be read", async () => {
    server.authFetch.mockResolvedValue(
      new Response("<html>502</html>", { status: 502 }),
    );
    render(<LocalModelRates />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load the prices stored on this machine. Try reloading the page.",
    );
  });

  it("shows the local server's own message when loading fails", async () => {
    server.authFetch.mockResolvedValue(
      Response.json(
        {
          ok: false,
          code: "storage_error",
          message:
            "Could not read the rates stored on this machine. Check that the .mcpjam folder in your home directory is writable, then try again.",
        },
        { status: 500 },
      ),
    );
    render(<LocalModelRates />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not read the rates stored on this machine. Check that the .mcpjam folder",
    );
  });

  it("drops a malformed row and shows the rest", async () => {
    server.rates = [{ rateId: "r9", modelId: "broken", revision: 1 }, llama];
    render(<LocalModelRates />);
    expect(await screen.findByText("llama3.2")).toBeTruthy();
    expect(screen.queryByText("broken")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the price in force today beside a scheduled one", async () => {
    server.rates = [scheduled];
    server.revisions = [scheduled, llama];
    render(<LocalModelRates />);
    const until = formatDay(scheduled.effectiveAt);
    const row = (await screen.findByText(`In force until ${until}`)).closest(
      "tr",
    )!;
    expect(row).toHaveTextContent("$0.1");
    expect(row).toHaveTextContent("$0.2");
    expect(row).toHaveTextContent(formatDay(llama.effectiveAt));
    expect(server.authFetch).toHaveBeenCalledWith(
      "/api/mcp/model-rate-overrides?providerKey=ollama&modelId=llama3.2",
      undefined,
    );
  });

  it("says no price is in force before a scheduled one starts", async () => {
    server.rates = [scheduled];
    server.revisions = [scheduled];
    render(<LocalModelRates />);
    expect(
      await screen.findByText(
        `No price in force until ${formatDay(scheduled.effectiveAt)}.`,
      ),
    ).toBeTruthy();
  });

  it("keeps the list when a scheduled rate's history fails to load", async () => {
    server.rates = [scheduled, { ...llama, rateId: "r3", modelId: "qwen3" }];
    server.authFetch.mockImplementation(async (url: string) =>
      url.includes("?")
        ? Response.json({ ok: false, message: "Read failed." }, { status: 500 })
        : Response.json({ ok: true, rates: server.rates }),
    );
    render(<LocalModelRates />);
    expect(await screen.findByText("qwen3")).toBeTruthy();
    expect(screen.getByText("llama3.2")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/In force until|No price in force/)).toBeNull();
  });

  it("names the model on each row action for screen readers", async () => {
    render(<LocalModelRates />);
    await screen.findByText("llama3.2");
    expect(
      screen.getByRole("button", { name: "Edit llama3.2" }),
    ).toHaveTextContent("Edit");
    expect(
      screen.getByRole("button", { name: "Retire llama3.2" }),
    ).toHaveTextContent("Retire");
  });

  it("moves the in-force row to the next scheduled revision when it starts", async () => {
    const MINUTE = 60_000;
    const start = Date.UTC(2026, 10, 17, 12);
    vi.useFakeTimers({ now: start });
    try {
      const old = { ...llama, effectiveAt: start - MINUTE };
      const next = {
        ...llama,
        rateId: "r4",
        rates: { currency: "USD", input: 0.5, output: 0.6 },
        effectiveAt: start + MINUTE,
        revision: 2,
      };
      const newest = {
        ...scheduled,
        rateId: "r5",
        rates: { currency: "USD", input: 0.9, output: 1 },
        effectiveAt: start + 2 * MINUTE,
        revision: 3,
      };
      server.rates = [newest];
      server.revisions = [newest, next, old];
      render(<LocalModelRates />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const inForceRow = () =>
        screen.getByText(/^In force until/).closest("tr")!;
      expect(inForceRow()).toHaveTextContent("$0.1");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(MINUTE + 1);
      });
      expect(inForceRow()).toHaveTextContent("$0.5");
      expect(inForceRow()).not.toHaveTextContent("$0.1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("picks the in-force revision after its history answers, not before", async () => {
    const MINUTE = 60_000;
    const start = Date.UTC(2026, 10, 17, 12);
    vi.useFakeTimers({ now: start });
    try {
      const old = { ...llama, effectiveAt: start - MINUTE };
      const next = {
        ...llama,
        rateId: "r4",
        rates: { currency: "USD", input: 0.5, output: 0.6 },
        effectiveAt: start + MINUTE,
        revision: 2,
      };
      const newest = {
        ...scheduled,
        rateId: "r5",
        rates: { currency: "USD", input: 0.9, output: 1 },
        effectiveAt: start + 5 * MINUTE,
        revision: 3,
      };
      // The history answers after `next` has started.
      server.authFetch.mockImplementation(async (url: string) => {
        if (!url.includes("?")) {
          return Response.json({ ok: true, rates: [newest] });
        }
        await new Promise((resolve) => setTimeout(resolve, 2 * MINUTE));
        return Response.json({ ok: true, revisions: [newest, next, old] });
      });
      render(<LocalModelRates />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2 * MINUTE + 1);
      });
      const row = screen.getByText(/^In force until/).closest("tr")!;
      expect(row).toHaveTextContent("$0.5");
      expect(row).toHaveTextContent(
        `In force until ${formatDay(newest.effectiveAt)}`,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a raw network error out of the load failure", async () => {
    server.authFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<LocalModelRates />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Could not load the prices stored on this machine. Try reloading the page.",
    );
    expect(alert).not.toHaveTextContent("Failed to fetch");
  });

  it("renders nothing and asks for nothing with the flag off", () => {
    flag.on = false;
    const { container } = render(<LocalModelRates />);
    expect(container).toBeEmptyDOMElement();
    expect(server.authFetch).not.toHaveBeenCalled();
  });
});
