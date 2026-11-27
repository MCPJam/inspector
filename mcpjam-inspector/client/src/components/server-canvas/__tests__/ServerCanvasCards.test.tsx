import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { FeatureAssessment, FeatureUserState } from "@mcpjam/sdk/browser";
import { FeatureRow } from "../FeatureRows";
import { ServerFeatureCard, ServerRootCard } from "../ServerCanvasCards";
import { buildFeatureCards, type FeatureRowModel } from "../feature-tree";
import { SERVER_FEATURE_CATALOG, evaluate, storedEvidence } from "./fixtures";

const cards = buildFeatureCards(SERVER_FEATURE_CATALOG, evaluate(storedEvidence()));
const feature = SERVER_FEATURE_CATALOG.find((entry) => entry.id === "prompts.capability")!;

function rowIn(
  state: FeatureUserState,
  extra: Partial<FeatureAssessment> = {},
): FeatureRowModel {
  return {
    feature,
    depth: 0,
    assessment: {
      featureId: feature.id,
      state,
      sources: [],
      markers: [],
      applicability: "applies",
      evidence: [],
      ...extra,
    },
  };
}

function renderRow(row: FeatureRowModel, onOpenRun = vi.fn()) {
  const onSelect = vi.fn();
  render(
    <ul>
      <FeatureRow row={row} selected={false} onSelect={onSelect} onOpenRun={onOpenRun} />
    </ul>,
  );
  return { onSelect, onOpenRun, item: screen.getByRole("listitem") };
}

describe("FeatureRow", () => {
  it("shows a supported row's strongest source as its chip", () => {
    const { item, onSelect } = renderRow(
      rowIn("supported", { sources: ["observed", "declared"], markers: ["beta"] }),
    );
    expect(item).toHaveAttribute("data-state", "supported");
    expect(within(item).getByText("Seen in use")).toBeInTheDocument();
    expect(within(item).getByText("Beta")).toBeInTheDocument();
    const button = within(item).getByRole("button", {
      name: "prompts capability, Supported, Seen in use, Beta",
    });
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith("prompts.capability");
  });

  it("tints a could-add row with the warning role and marks it +", () => {
    const { item } = renderRow(rowIn("could-add"));
    expect(item.className).toContain("bg-warning/15");
    expect(within(item).getByText("+ Could add")).toBeInTheDocument();
  });

  it("outlines a needs-newer row and marks it ↗", () => {
    const { item } = renderRow(rowIn("needs-newer"));
    expect(item.className).toContain("border");
    expect(within(item).getByText("↗ Needs newer")).toBeInTheDocument();
  });

  it("says a needs-newer row depends on the client or host when it does", () => {
    const { item } = renderRow({ ...rowIn("needs-newer"), needsNewer: "client" });
    expect(within(item).getByText("↗ Depends on client")).toBeInTheDocument();
    expect(
      within(item).getByRole("button", {
        name: "prompts capability, Depends on the client",
      }),
    ).toBeInTheDocument();
    cleanup();
    const host = renderRow({ ...rowIn("needs-newer"), needsNewer: "host" });
    expect(within(host.item).getByText("↗ Depends on host")).toBeInTheDocument();
  });

  it("mutes a not-checked row", () => {
    const { item } = renderRow(rowIn("not-checked"));
    expect(item.className).toContain("text-muted-foreground");
    expect(within(item).getByText("Not checked")).toBeInTheDocument();
  });

  it("links a failed check to its run", () => {
    const { item, onOpenRun } = renderRow(
      rowIn("check-failed", {
        evidence: [
          {
            featureId: feature.id,
            source: "checked",
            outcome: "failed",
            provenance: "wire",
            intrusiveness: "side-effecting",
            coverage: "complete",
            ref: { runId: "run_1", check: "protocol:server-initialize" },
          },
        ],
      }),
    );
    expect(item.className).toContain("text-destructive");
    fireEvent.click(
      within(item).getByRole("button", {
        name: "Open the run where prompts capability failed",
      }),
    );
    expect(onOpenRun).toHaveBeenCalledWith("run_1");
  });

  it("de-emphasizes a not-applicable row", () => {
    const { item } = renderRow(rowIn("not-applicable"));
    expect(item.className).toContain("opacity-70");
    expect(within(item).getByText("Not applicable")).toBeInTheDocument();
  });
});

describe("ServerFeatureCard", () => {
  const serverFeatures = cards.find((card) => card.id === "server-features")!;

  function renderCard(expanded: string[] = []) {
    const handlers = {
      isExpanded: (id: string) => expanded.includes(id),
      selectedId: null,
      onActivateFamily: vi.fn(),
      onSelect: vi.fn(),
    };
    render(<ServerFeatureCard card={serverFeatures} handlers={handlers} />);
    return handlers;
  }

  it("heads the card with counts and a bar split by them", () => {
    renderCard();
    const card = screen.getByRole("region", { name: "Server Features" });
    expect(
      within(card).getByText(
        "7 supported · 12 could add · 22 not checked · 5 need newer",
      ),
    ).toBeInTheDocument();
    const segments = within(card)
      .getAllByTestId("feature-counts-bar")[0]
      .querySelectorAll("[data-state]");
    // The text leaves not applicable out, so the bar does too.
    expect(Array.from(segments).map((s) => s.getAttribute("data-state"))).toEqual([
      "supported",
      "could-add",
      "not-checked",
      "needs-newer",
    ]);
  });

  it("shows collapsed families with their own counts", () => {
    const handlers = renderCard();
    const tools = screen.getByRole("button", { name: /^Tools/ });
    expect(tools).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: /^tools\/list/ })).toBeNull();
    fireEvent.click(tools);
    expect(handlers.onActivateFamily).toHaveBeenCalledWith("tools-discovery");
  });

  it("shows a family's feature rows once expanded", () => {
    renderCard(["tools-discovery"]);
    expect(screen.getByRole("button", { name: /^Tools/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(
      screen.getByRole("button", { name: /^tools\/list, Supported/ }),
    ).toBeInTheDocument();
  });
});

describe("ServerRootCard", () => {
  it("names the server and what the counts are scoped to", () => {
    render(
      <ServerRootCard
        summary={{
          name: "Atlas Workspace",
          version: "1.8.0",
          protocolVersion: "2025-11-25",
          featureCount: 257,
        }}
      />,
    );
    expect(screen.getByText("Atlas Workspace")).toBeInTheDocument();
    expect(screen.getByText("v1.8.0 · 2025-11-25")).toBeInTheDocument();
    expect(
      screen.getByText("257 features · scoped to this client and account"),
    ).toBeInTheDocument();
  });
});
