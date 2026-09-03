import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TraceDestinationDialog } from "../TraceDestinationDialog";
import type { TraceDestination } from "@/hooks/useOrgTraceDestinations";

/**
 * The dialog's job is to be honest about a backend contract it cannot soften:
 * header values are write-only, so the stored SET can be replaced or left
 * alone and never edited item by item.
 */

const onSubmit = vi.fn();

function existing(overrides: Partial<TraceDestination> = {}): TraceDestination {
  return {
    id: "d1",
    organizationId: "org1",
    name: "Coralogix",
    enabled: true,
    endpointUrl: "https://ingress.us1.coralogix.com:443/v1/traces",
    headerNames: ["Authorization"],
    resourceAttributes: {},
    sourceTypes: ["eval"],
    includeContent: false,
    compression: "gzip",
    projectIds: null,
    preset: "coralogix",
    paused: null,
    health: null,
    lastTest: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function open(destination: TraceDestination | null) {
  return render(
    <TraceDestinationDialog
      open
      onOpenChange={() => {}}
      destination={destination}
      projects={[{ id: "p1", name: "Checkout" }]}
      isSaving={false}
      error={null}
      onSubmit={onSubmit}
    />,
  );
}

describe("TraceDestinationDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onSubmit.mockResolvedValue(undefined);
  });

  it("shows the stored region, not the default", () => {
    // Editing a us1 destination used to show the picker on eu2, and touching
    // any other field then re-derived the endpoint from that stale selection
    // — silently moving the destination to another continent.
    open(existing());
    expect(
      screen.getByDisplayValue(/ingress\.us1\.coralogix\.com/),
    ).toBeTruthy();
    expect(screen.getByText("us1")).toBeTruthy();
  });

  it("sends no headers when nothing about them changed", async () => {
    open(existing());
    fireEvent.click(screen.getByText("Save changes"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty("headers");
  });

  it("refuses a partial edit when ONE of several stored rows is removed", async () => {
    // The Remove button used to be a no-op here: the row vanished locally,
    // the survivor carried no value so the payload omitted `headers`, and the
    // backend kept the whole set — including the one just deleted.
    open(existing({ headerNames: ["Authorization", "X-Team"] }));
    fireEvent.click(screen.getAllByLabelText("Remove headers row")[1]);
    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/replace-only/i),
    );
    expect(screen.getByRole("alert").textContent).toContain("Authorization");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("clears the headers when every row is removed", async () => {
    // Removing them ALL is unambiguous — there is no value left to re-enter —
    // so it sends the empty set the backend reads as "remove them", rather
    // than the omission it reads as "leave them".
    open(existing());
    fireEvent.click(screen.getByLabelText("Remove headers row"));
    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].headers).toEqual({});
  });

  it("accepts the edit once every remaining value is re-entered", async () => {
    open(existing({ headerNames: ["Authorization", "X-Team"] }));
    fireEvent.click(screen.getAllByLabelText("Remove headers row")[1]);
    fireEvent.change(screen.getByLabelText("Headers value"), {
      target: { value: "Bearer replaced" },
    });
    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].headers).toEqual({
      Authorization: "Bearer replaced",
    });
  });

  it("refuses to move stored credentials to a new origin", async () => {
    // Header values are write-only, so an admin who never knew the stored key
    // could otherwise repoint this at a collector they control and read it
    // off the next delivery.
    open(existing());
    const endpoint = screen.getByLabelText("Endpoint URL");
    fireEvent.change(endpoint, {
      target: { value: "https://collector.example.com" },
    });
    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(
        /stored headers would go with it/i,
      ),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("allows a same-origin path change without re-entering headers", async () => {
    open(existing());
    fireEvent.change(screen.getByLabelText("Endpoint URL"), {
      target: { value: "https://ingress.us1.coralogix.com:443/v1/traces?x=1" },
    });
    fireEvent.click(screen.getByText("Save changes"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  });

  it("refuses a reserved mcpjam.* resource attribute", async () => {
    open(null);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Collector" },
    });
    fireEvent.change(screen.getByLabelText("Endpoint URL"), {
      target: { value: "https://collector.example.com" },
    });
    const attrRows = screen.getAllByLabelText("Resource attributes name");
    fireEvent.change(attrRows[0], { target: { value: "mcpjam.run.id" } });
    fireEvent.click(screen.getByText("Create"));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/reserved/i),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not overwrite an endpoint the admin already typed", async () => {
    open(null);
    fireEvent.change(screen.getByLabelText("Endpoint URL"), {
      target: { value: "https://my-collector.internal.example.com" },
    });
    // Picking a vendor for its header names must not discard the URL.
    fireEvent.click(screen.getByLabelText(/vendor/i));
    expect(
      screen.getByDisplayValue("https://my-collector.internal.example.com"),
    ).toBeTruthy();
  });
});
