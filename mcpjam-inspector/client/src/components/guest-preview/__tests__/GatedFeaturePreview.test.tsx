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
import { SwarmsEmptyHero } from "@/components/swarms/swarms-empty-hero";
import { UserTestingEmptyState } from "@/components/scenarios/UserTestingOverviewPanel";

const FEATURES = ["swarms", "user-testing"] as const;

describe("GuestFeaturePreview", () => {
  beforeEach(() => {
    vi.mocked(track).mockReset();
  });

  it.each(FEATURES)("renders %s's divider and sample", (feature) => {
    const copy = GATED_FEATURE_COPY[feature];
    render(
      <GuestFeaturePreview feature={feature}>
        <button type="button">Create account</button>
      </GuestFeaturePreview>,
    );

    expect(screen.getByText(copy.sampleLabel)).toBeInTheDocument();
    expect(screen.getByText(copy.sample.title)).toBeInTheDocument();
  });

  /**
   * Ozi's requirement, stated directly: the graphic, heading and body must be
   * IDENTICAL signed in and signed out. Only the control differs.
   *
   * These assertions compare the preview against the real empty state rendered
   * beside it, rather than against a string literal copied into the test. A
   * literal would pass while both sides drifted together, which is the failure
   * this is here to catch: the previous preview kept its own `heroTitle` and
   * `heroBody`, and the User Testing body had already become a paraphrase that
   * changed three words nobody approved.
   */
  describe("shows a member and a visitor the same empty state", () => {
    const headingAndBody = (container: HTMLElement) => ({
      heading: container.querySelector("h2, h3")?.textContent,
      body: container.querySelector("p")?.textContent,
    });

    it("matches the real Swarms empty state", () => {
      const real = render(<SwarmsEmptyHero onNewSwarm={() => {}} />);
      const member = headingAndBody(real.container);
      real.unmount();

      const guest = render(
        <GuestFeaturePreview feature="swarms">
          <button type="button">Create account</button>
        </GuestFeaturePreview>,
      );

      expect(member.heading).toBeTruthy();
      expect(member.body).toBeTruthy();
      expect(screen.getByText(member.heading as string)).toBeInTheDocument();
      expect(screen.getByText(member.body as string)).toBeInTheDocument();
      guest.unmount();
    });

    it("matches the real User Testing empty state", () => {
      const real = render(<UserTestingEmptyState onCreateScenario={() => {}} />);
      const member = headingAndBody(real.container);
      real.unmount();

      const guest = render(
        <GuestFeaturePreview feature="user-testing">
          <button type="button">Create account</button>
        </GuestFeaturePreview>,
      );

      expect(member.heading).toBeTruthy();
      expect(member.body).toBeTruthy();
      expect(screen.getByText(member.heading as string)).toBeInTheDocument();
      expect(screen.getByText(member.body as string)).toBeInTheDocument();
      guest.unmount();
    });

    // The half that keeps "identical" from meaning "identical including the
    // button a visitor cannot use".
    it.each(FEATURES)("replaces %s's create button with the CTA", (feature) => {
      render(
        <GuestFeaturePreview feature={feature}>
          <button type="button">Create account</button>
        </GuestFeaturePreview>,
      );

      expect(
        screen.getByRole("button", { name: "Create account" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /create (new swarm|your first)/i }),
      ).not.toBeInTheDocument();
    });
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

  it("draws the Swarms sample as the Findings tab, personas and all", () => {
    const sample = GATED_FEATURE_COPY.swarms.sample;
    if (sample.kind !== "findings") throw new Error("expected findings");
    render(
      <GuestFeaturePreview feature="swarms">
        <button type="button">Create account</button>
      </GuestFeaturePreview>,
    );

    const card = screen.getByTestId("gated-feature-sample");
    expect(within(card).getByText(sample.summary)).toBeInTheDocument();
    for (const persona of sample.personas) {
      expect(within(card).getByText(persona.name)).toBeInTheDocument();
    }
  });

  // Not every persona is satisfied, deliberately. A swarm where everyone
  // sailed through has found nothing, and finding something is the product.
  it("shows the Swarms sample finding a problem, not a clean sweep", () => {
    const sample = GATED_FEATURE_COPY.swarms.sample;
    if (sample.kind !== "findings") throw new Error("expected findings");

    expect(
      sample.personas.some((p) => p.sentiment === "uneasy"),
    ).toBe(true);
    expect(
      sample.personas.some((p) => p.sentiment === "satisfied"),
    ).toBe(true);
  });

  it("draws the User Testing sample as the four-column session flow", () => {
    const sample = GATED_FEATURE_COPY["user-testing"].sample;
    if (sample.kind !== "flow") throw new Error("expected flow");
    render(
      <GuestFeaturePreview feature="user-testing">
        <button type="button">Create account</button>
      </GuestFeaturePreview>,
    );

    const card = screen.getByTestId("gated-feature-sample");
    // The real columns, in the real order.
    expect(sample.stages.map((stage) => stage.label)).toEqual([
      "Goal",
      "Behavior",
      "Outcome",
      "Sentiment",
    ]);
    for (const stage of sample.stages) {
      expect(within(card).getByText(stage.label)).toBeInTheDocument();
    }
  });

  /**
   * The bug Ozi caught, pinned so it cannot come back quietly.
   *
   * The previous renderer drew segment `j` to segment `j`, which is four
   * parallel rails: no split, no merge, no crossing. Every assertion here
   * would have failed against it, and none of the assertions above would.
   */
  describe("the User Testing flow shows paths that actually diverge", () => {
    const sample = GATED_FEATURE_COPY["user-testing"].sample;
    if (sample.kind !== "flow") throw new Error("expected flow");
    const linked = sample.stages.filter((stage) => stage.links?.length);

    it("splits at least one node into several destinations", () => {
      const splits = linked.flatMap((stage) => {
        const out = new Map<number, number>();
        for (const link of stage.links ?? []) {
          out.set(link.from, (out.get(link.from) ?? 0) + 1);
        }
        return [...out.values()].filter((n) => n > 1);
      });
      expect(splits.length).toBeGreaterThan(0);
    });

    it("merges several sources into at least one node", () => {
      const merges = linked.flatMap((stage) => {
        const into = new Map<number, number>();
        for (const link of stage.links ?? []) {
          into.set(link.to, (into.get(link.to) ?? 0) + 1);
        }
        return [...into.values()].filter((n) => n > 1);
      });
      expect(merges.length).toBeGreaterThan(0);
    });

    it("carries the crossing the card exists for: goal reached, felt nothing", () => {
      const outcome = sample.stages.find((stage) => stage.label === "Outcome");
      const sentiment = sample.stages.find(
        (stage) => stage.label === "Sentiment",
      );
      const reachedIdx =
        outcome?.nodes.findIndex((n) => n.label === "Goal reached") ?? -1;
      const neutralIdx =
        sentiment?.nodes.findIndex((n) => n.label === "Neutral") ?? -1;
      expect(reachedIdx).toBeGreaterThanOrEqual(0);
      expect(neutralIdx).toBeGreaterThanOrEqual(0);

      const crossing = outcome?.links?.find(
        (link) => link.from === reachedIdx && link.to === neutralIdx,
      );
      expect(crossing).toBeDefined();
      expect(crossing?.share).toBeGreaterThan(0);
    });

    /**
     * `SampleFlow` does not repair shares that do not add up; it draws them
     * wrong, leaving a ribbon overhanging its own bar. Hand-authored numbers
     * are exactly where that happens, so the arithmetic is checked here
     * rather than trusted.
     */
    it("conserves share across every column", () => {
      const round = (n: number) => Math.round(n * 1000) / 1000;

      sample.stages.forEach((stage, i) => {
        if (!stage.links) return;
        const next = sample.stages[i + 1];

        stage.nodes.forEach((node, j) => {
          const out = stage.links!
            .filter((link) => link.from === j)
            .reduce((sum, link) => sum + link.share, 0);
          expect(round(out)).toBe(round(node.share));
        });

        next.nodes.forEach((node, j) => {
          const into = stage.links!
            .filter((link) => link.to === j)
            .reduce((sum, link) => sum + link.share, 0);
          expect(round(into)).toBe(round(node.share));
        });
      });
    });

    it("keeps every link pointing at a node that exists", () => {
      sample.stages.forEach((stage, i) => {
        for (const link of stage.links ?? []) {
          expect(stage.nodes[link.from]).toBeDefined();
          expect(sample.stages[i + 1]?.nodes[link.to]).toBeDefined();
        }
      });
    });
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
