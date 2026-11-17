import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalModelRates } from "../local-model-rates";

vi.mock("@/hooks/useTraceCostEnabled", () => ({
  useTraceCostEnabled: () => true,
}));
const server = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@/lib/session-token", () => ({ authFetch: server.authFetch }));
// The panel's rendering is covered elsewhere; this reads what it is given.
const panel = vi.hoisted(() => ({
  onSave: undefined as undefined | ((rate: unknown) => Promise<void>),
}));
vi.mock("../model-rates-panel", () => ({
  useWakeAt: () => undefined,
  ModelRatesPanel: (props: {
    rates?: { modelId: string }[];
    onSave: (rate: unknown) => Promise<void>;
  }) => {
    panel.onSave = props.onSave;
    return (
      <div data-testid="rates">
        {props.rates?.map((rate) => rate.modelId).join(",") ?? "loading"}
      </div>
    );
  },
}));

const llama = {
  rateId: "r1",
  providerKey: "ollama",
  modelId: "llama3.2",
  rates: { currency: "USD", input: 0.1, output: 0.2 },
  effectiveAt: Date.UTC(2026, 9, 1),
  revision: 1,
};

describe("LocalModelRates reloads", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps a save's reload when the first load finishes after it", async () => {
    let finishFirstLoad!: () => void;
    server.authFetch
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishFirstLoad = () =>
              resolve(Response.json({ ok: true, rates: [] }));
          }),
      )
      .mockImplementationOnce(async () => Response.json({ ok: true }))
      .mockImplementationOnce(async () =>
        Response.json({ ok: true, rates: [llama] }),
      );

    render(<LocalModelRates />);
    await act(async () => {
      await panel.onSave!({ modelId: "llama3.2" });
    });
    expect(screen.getByTestId("rates")).toHaveTextContent("llama3.2");

    await act(async () => finishFirstLoad());
    expect(screen.getByTestId("rates")).toHaveTextContent("llama3.2");
  });
});
