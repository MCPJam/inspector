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
import { GatedFeaturePreview } from "../GatedFeaturePreview";
import { GATED_FEATURE_COPY, SAMPLE_DATA_NOTE } from "../feature-highlights";

describe("GatedFeaturePreview", () => {
  beforeEach(() => {
    vi.mocked(track).mockReset();
  });

  it.each(["swarms", "user-testing"] as const)(
    "renders %s's own hero copy and its three card titles",
    (feature) => {
      const copy = GATED_FEATURE_COPY[feature];
      render(
        <GatedFeaturePreview feature={feature}>
          <button type="button">Create free account</button>
        </GatedFeaturePreview>,
      );

      expect(screen.getByText(copy.heroTitle)).toBeInTheDocument();
      expect(screen.getByText(copy.heroBody)).toBeInTheDocument();
      expect(screen.getByText(copy.cardsLabel)).toBeInTheDocument();
      for (const card of copy.cards) {
        expect(screen.getByText(card.title)).toBeInTheDocument();
      }
    },
  );

  // The whole point of the shared component: guest and plan-locked read the
  // same pitch and differ only in the way out, which arrives as children.
  it("renders whatever call to action it is handed, and nothing of its own", () => {
    const { rerender } = render(
      <GatedFeaturePreview feature="swarms">
        <button type="button">Create free account</button>
      </GatedFeaturePreview>,
    );
    expect(
      screen.getByRole("button", { name: "Create free account" }),
    ).toBeInTheDocument();

    rerender(
      <GatedFeaturePreview feature="swarms">
        <button type="button">See plans</button>
      </GatedFeaturePreview>,
    );
    expect(screen.getByRole("button", { name: "See plans" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create free account" }),
    ).not.toBeInTheDocument();
  });

  // A guest has no account and a plan-locked user has no entitlement, so the
  // real tab's "Create new swarm" / "Create new study" must not be here — a
  // disabled control reads as broken, a live one that opens a wall as a trick.
  it.each(["swarms", "user-testing"] as const)(
    "gives %s a title-only header with no create button",
    (feature) => {
      const copy = GATED_FEATURE_COPY[feature];
      render(
        <GatedFeaturePreview feature={feature}>
          <button type="button">Create free account</button>
        </GatedFeaturePreview>,
      );

      const heading = screen.getByRole("heading", {
        level: 1,
        name: copy.navLabel,
      });
      expect(heading).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /create new (swarm|study)/i }),
      ).not.toBeInTheDocument();
    },
  );

  // BB-120's objection to faked charts is answered on the page, not in a
  // reviewer's memory.
  it("labels the example figures as a sample", () => {
    render(
      <GatedFeaturePreview feature="user-testing">
        <button type="button">Create free account</button>
      </GatedFeaturePreview>,
    );

    expect(screen.getByText(SAMPLE_DATA_NOTE)).toBeInTheDocument();
  });

  // Three panels of invented numbers tell a screen-reader user nothing true;
  // the hero copy above carries the same message in words.
  it("hides the example cards from assistive tech", () => {
    render(
      <GatedFeaturePreview feature="swarms">
        <button type="button">Create free account</button>
      </GatedFeaturePreview>,
    );

    const card = screen
      .getByText(GATED_FEATURE_COPY.swarms.cards[0].title)
      .closest("[aria-hidden]");
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText("88%")).toBeInTheDocument();
  });

  it("reports one impression per mount, not per render", () => {
    const { rerender } = render(
      <GatedFeaturePreview feature="swarms">
        <button type="button">Create free account</button>
      </GatedFeaturePreview>,
    );
    rerender(
      <GatedFeaturePreview feature="swarms">
        <button type="button">Create free account</button>
      </GatedFeaturePreview>,
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

  it("tags each surface with its own analytics location", () => {
    render(
      <GatedFeaturePreview feature="user-testing">
        <button type="button">Create free account</button>
      </GatedFeaturePreview>,
    );

    expect(track).toHaveBeenCalledWith(
      "guest_feature_preview_shown",
      expect.objectContaining({ location: "user_testing_guest_preview" }),
    );
  });
});
