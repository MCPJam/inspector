import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalModelRates } from "../local-model-rates";
import { __resetListPricesForTests } from "../use-list-prices";

const flag = vi.hoisted(() => ({ on: true }));
vi.mock("@/hooks/useTraceCostEnabled", () => ({
  useTraceCostEnabled: () => flag.on,
}));
vi.mock("@/lib/convex-site-url", () => ({ getConvexSiteUrl: () => null }));
const server = vi.hoisted(() => ({ authFetch: vi.fn() }));
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

describe("LocalModelRates", () => {
  beforeEach(() => {
    __resetListPricesForTests();
    server.authFetch.mockImplementation(
      async (url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? Response.json({ ok: true, rate: llama })
          : Response.json({ ok: true, rates: [llama] }),
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
