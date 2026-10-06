import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaxIdStatusSection } from "../TaxIdStatusSection";

const listTaxIds = vi.hoisted(() => vi.fn());
vi.mock("convex/react", () => ({ useAction: () => listTaxIds }));

beforeEach(() => {
  listTaxIds.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});
const taxId = (status: string, value = "DE123456789") => ({
  id: value,
  type: "eu_vat",
  value,
  status,
});

describe("TaxIdStatusSection", () => {
  it.each([
    ["pending", "Verification pending"],
    ["verified", "Verified"],
    ["unverified", "Not verified"],
    ["unavailable", "Verification unavailable"],
  ])(
    "shows %s without implying verification when unavailable",
    async (status, label) => {
      listTaxIds.mockResolvedValue([taxId(status)]);
      render(<TaxIdStatusSection organizationId="org-1" />);
      expect(await screen.findByText(label)).toBeInTheDocument();
      expect(screen.getByText("DE123456789")).toBeInTheDocument();
      expect(listTaxIds).toHaveBeenCalledWith({ organizationId: "org-1" });
    },
  );

  it("shows an error and lets the owner retry", async () => {
    listTaxIds
      .mockRejectedValueOnce(new Error("Private Stripe error"))
      .mockResolvedValueOnce([]);
    render(<TaxIdStatusSection organizationId="org-1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load",
    );
    expect(screen.queryByText("Private Stripe error")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh status" }));
    expect(await screen.findByText("No tax IDs added.")).toBeInTheDocument();
  });

  it("refreshes pending verification and stops once verified", async () => {
    vi.useFakeTimers();
    listTaxIds
      .mockResolvedValueOnce([taxId("pending")])
      .mockResolvedValue([taxId("verified")]);
    render(<TaxIdStatusSection organizationId="org-1" />);
    await act(async () => {});
    expect(screen.getByText("Verification pending")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByText("Verified")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(listTaxIds).toHaveBeenCalledTimes(2);
  });

  it("retains pending status and retries after a failed poll", async () => {
    vi.useFakeTimers();
    listTaxIds
      .mockResolvedValueOnce([taxId("pending")])
      .mockRejectedValueOnce(new Error("Private Stripe error"))
      .mockResolvedValue([taxId("verified")]);
    render(<TaxIdStatusSection organizationId="org-1" />);
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByText("Verification pending")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load");
    expect(screen.queryByText("Private Stripe error")).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(listTaxIds).toHaveBeenCalledTimes(3);
  });

  it("keeps the current status visible during a slow poll", async () => {
    vi.useFakeTimers();
    let finishRefresh!: (value: unknown) => void;
    listTaxIds.mockResolvedValueOnce([taxId("pending")]).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRefresh = resolve;
        }),
    );
    render(<TaxIdStatusSection organizationId="org-1" />);
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByText("Verification pending")).toBeInTheDocument();
    expect(screen.getByText("Refreshing status…")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(listTaxIds).toHaveBeenCalledTimes(2);
    await act(async () => {
      finishRefresh([taxId("verified")]);
    });
    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(screen.queryByText("Refreshing status…")).not.toBeInTheDocument();
  });

  it("does not show a late response for another organization", async () => {
    let resolveOld!: (value: unknown) => void;
    listTaxIds
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce([taxId("verified", "NEW-ID")]);
    const view = render(<TaxIdStatusSection organizationId="org-1" />);
    view.rerender(<TaxIdStatusSection organizationId="org-2" />);
    expect(await screen.findByText("NEW-ID")).toBeInTheDocument();
    await act(async () => {
      resolveOld([taxId("verified", "PRIVATE-OLD-ID")]);
    });
    expect(screen.queryByText("PRIVATE-OLD-ID")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("NEW-ID")).toBeInTheDocument());
  });
});
