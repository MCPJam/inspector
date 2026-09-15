import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Analytics goes through lib/analytics.ts#track (the ratchet forbids raw
// posthog.capture in components); mock it to assert the surface tag.
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

// The golem row renders four PersonaPixelAvatars with their own animation and
// procedural drawing; the preview only cares that a hero is present.
vi.mock("@/components/swarms/swarm-hero-characters", () => ({
  SwarmHeroCharacters: () => <div data-testid="swarm-hero-characters" />,
}));

import { track } from "@/lib/analytics";
import { GuestFeaturePreview } from "../GatedFeaturePreview";
import { GATED_FEATURE_COPY } from "../feature-highlights";

const FEATURES = ["swarms", "user-testing"] as const;

describe("GuestFeaturePreview", () => {
  beforeEach(() => {
    vi.mocked(track).mockReset();
  });

  it.each(FEATURES)("renders %s's own hero copy and sample", (feature) => {
    const copy = GATED_FEATURE_COPY[feature];
    render(
      <GuestFeaturePreview feature={feature}>
        <button type="button">Create account</button>
      </GuestFeaturePreview>,
    );

    expect(screen.getByText(copy.heroTitle)).toBeInTheDocument();
    // Optional by design: Swarms' sourced headline carries the whole pitch,
    // so there is no second line under it to invent.
    if (copy.heroBody) {
      expect(screen.getByText(copy.heroBody)).toBeInTheDocument();
    }
    expect(screen.getByText(copy.sampleLabel)).toBeInTheDocument();
    expect(screen.getByText(copy.sample.title)).toBeInTheDocument();
  });

  // Exactly one. The first draft showed three, which crowded the page and
  // needed two more invented screens to fill.
  it.each(FEATURES)("shows a single sample card on %s", (feature) => {
    render(
      <GuestFeaturePreview feature={feature}>
        <button type="button">Create account</button>
      </GuestFeaturePreview>,
    );

    expect(screen.getAllByTestId("gated-feature-sample")).toHaveLength(1);
  });

  it("draws the Swarms sample as run rows, not a chart", () => {
    const sample = GATED_FEATURE_COPY.swarms.sample;
    if (sample.kind !== "runs") throw new Error("expected runs");
    render(
      <GuestFeaturePreview feature="swarms">
        <button type="button">Create account</button>
      </GuestFeaturePreview>,
    );

    const card = screen.getByTestId("gated-feature-sample");
    for (const run of sample.runs) {
      expect(within(card).getByText(run.name)).toBeInTheDocument();
      expect(within(card).getByText(run.meta)).toBeInTheDocument();
    }
    // One outcome badge per row, the way Vig asked the row to become. A red
    // FAILED badge or a status dot would put the preview at odds with the
    // cleanup that is landing on the real list.
    expect(within(card).getAllByText("Completed")).toHaveLength(
      sample.runs.length,
    );
  });

  it("draws the User Testing sample as the session metric strip", () => {
    const sample = GATED_FEATURE_COPY["user-testing"].sample;
    if (sample.kind !== "metrics") throw new Error("expected metrics");
    render(
      <GuestFeaturePreview feature="user-testing">
        <button type="button">Create account</button>
      </GuestFeaturePreview>,
    );

    const card = screen.getByTestId("gated-feature-sample");
    for (const tile of sample.tiles) {
      expect(within(card).getByText(tile.label)).toBeInTheDocument();
      expect(within(card).getByText(tile.value)).toBeInTheDocument();
    }
  });

  it("renders whatever call to action it is handed, and nothing of its own", () => {
    render(
      <GuestFeaturePreview feature="swarms">
        <button type="button">Create account</button>
      </GuestFeaturePreview>,
    );

    expect(
      screen.getByRole("button", { name: "Create account" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /create new (swarm|study)/i }),
    ).not.toBeInTheDocument();
  });

  it.each(FEATURES)("gives %s a title-only header", (feature) => {
    const copy = GATED_FEATURE_COPY[feature];
    render(
      <GuestFeaturePreview feature={feature}>
        <button type="button">Create account</button>
      </GuestFeaturePreview>,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: copy.navLabel }),
    ).toBeInTheDocument();
  });

  it("hides the sample from assistive tech", () => {
    render(
      <GuestFeaturePreview feature="swarms">
        <button type="button">Create account</button>
      </GuestFeaturePreview>,
    );

    expect(screen.getByTestId("gated-feature-sample")).toHaveAttribute(
      "aria-hidden",
    );
  });

  it("reports one impression per mount, not per render", () => {
    const { rerender } = render(
      <GuestFeaturePreview feature="swarms">
        <button type="button">Create account</button>
      </GuestFeaturePreview>,
    );
    rerender(
      <GuestFeaturePreview feature="swarms">
        <button type="button">Create account</button>
      </GuestFeaturePreview>,
    );

    const impressions = vi
      .mocked(track)
      .mock.calls.filter(([event]) => event === "guest_feature_preview_shown");
    expect(impressions).toHaveLength(1);
    expect(impressions[0][1]).toEqual(
      expect.objectContaining({
        location: "swarms_guest_preview",
        feature: "swarms",
      }),
    );
  });
});
