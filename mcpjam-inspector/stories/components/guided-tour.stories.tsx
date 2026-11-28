import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import {
  FeatureSpotlightActions,
  FeatureSpotlightDescription,
  FeatureSpotlightTitle,
} from "@mcpjam/design-system/feature-spotlight";
import {
  TourCoachmark,
  TourStepContent,
} from "@/components/guided-tour/coachmark";
import {
  useAnchorRects,
  type CoachmarkPlacement,
} from "@/components/guided-tour/geometry";
import {
  TourGhostCursor,
  type GhostCursorHandle,
} from "@/components/guided-tour/ghost-cursor";
import { TourSpotlight } from "@/components/guided-tour/spotlight";
import { useTourPlayer } from "@/components/guided-tour/use-tour-player";
import { ThemePair } from "../_support/theme-pair";

/**
 * Guided tour stories. When to use a tour, and how to build one, is on the
 * Overview page (GuidedTour.mdx). The Evaluate tour is the first user; these
 * stories draw a small Conformance example on the same parts.
 */
const meta = {
  title: "Components/Guided Tour",
  component: TourCoachmark,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TourCoachmark>;

export default meta;
type Story = StoryObj<typeof meta>;

const CATEGORIES = ["Protocol", "Apps", "Tasks", "OAuth"] as const;

function ExampleBadge() {
  return (
    <Badge variant="outline" className="absolute right-4 top-4">
      Example data
    </Badge>
  );
}

/** A mock Conformance page; `data-tour-anchor` marks what a stop can light. */
function ConformanceScreen() {
  return (
    <div className="relative flex h-full flex-col gap-4 bg-background p-6">
      <ExampleBadge />
      <div data-tour-anchor="header" className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Conformance</h1>
        <p className="text-sm text-muted-foreground">excalidraw</p>
      </div>
      <div
        data-tour-anchor="categories"
        className="grid w-fit grid-cols-2 gap-2"
      >
        {CATEGORIES.map((category) => (
          <div
            key={category}
            className="w-40 rounded-md border border-border bg-card px-3 py-2 text-sm"
          >
            {category}
          </div>
        ))}
      </div>
      <Button data-tour-anchor="run" size="sm" className="w-fit">
        Run checks
      </Button>
    </div>
  );
}

function ResultsScreen() {
  return (
    <div className="relative flex h-full flex-col gap-4 bg-background p-6">
      <ExampleBadge />
      <h1 className="text-lg font-semibold">Conformance results</h1>
      <ul data-tour-anchor="results" className="flex w-96 flex-col gap-2">
        {CATEGORIES.map((category, index) => (
          <li
            key={category}
            className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-sm"
          >
            {category}
            <Badge variant={index === 3 ? "destructive" : "secondary"}>
              {index === 3 ? "1 failed" : "Passed"}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Lights `anchors` on the mock page and pins a card to the first one. */
function Stage({
  anchors,
  placement,
  screen = <ConformanceScreen />,
  children,
}: {
  anchors: readonly string[];
  placement: CoachmarkPlacement;
  screen?: ReactNode;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { rects, bounds } = useAnchorRects(rootRef, anchors);
  return (
    <div ref={rootRef} className="relative h-[480px] overflow-hidden">
      <div inert className="absolute inset-0">
        {screen}
      </div>
      <TourSpotlight rects={rects} />
      {rects[0] ? (
        <TourCoachmark anchor={rects[0]} bounds={bounds} placement={placement}>
          {children}
        </TourCoachmark>
      ) : null}
    </div>
  );
}

const LABELS = ["Pick", "Run", "Fix"];
const noop = () => {};

/** One stop on each side the card can take. Switch `placement` in Controls. */
export const Coachmark: Story = {
  args: {
    placement: "right",
    anchor: { x: 0, y: 0, width: 0, height: 0 },
    bounds: { width: 0, height: 0 },
    children: null,
  },
  argTypes: {
    placement: { control: "inline-radio", options: ["bottom", "right", "top"] },
    anchor: { table: { disable: true } },
    bounds: { table: { disable: true } },
    children: { table: { disable: true } },
  },
  render: ({ placement }) => (
    <Stage anchors={["run"]} placement={placement}>
      <TourStepContent
        labels={LABELS}
        index={1}
        title="Run every check in one click"
        body="Conformance runs the spec's checks on your server and explains each failure."
        onNext={noop}
        onSkip={noop}
      />
    </Stage>
  ),
};

/** Several anchors lit at once; the card points at the first. */
export const MultipleAnchors: Story = {
  ...Coachmark,
  args: { ...Coachmark.args, placement: "bottom" },
  render: ({ placement }) => (
    <Stage anchors={["header", "categories"]} placement={placement}>
      <TourStepContent
        labels={LABELS}
        index={0}
        title="Pick what to check"
        body="Each category maps to a part of the MCP spec. Run one or all of them."
        onNext={noop}
        onSkip={noop}
      />
    </Stage>
  ),
};

/** The last word, pinned to the real control the user should press next. */
export const Handoff: Story = {
  ...Coachmark,
  render: () => (
    <Stage anchors={["run"]} placement="right">
      <FeatureSpotlightTitle>Your turn</FeatureSpotlightTitle>
      <FeatureSpotlightDescription>
        Run the checks on your own server.
      </FeatureSpotlightDescription>
      <FeatureSpotlightActions className="justify-end">
        <Button size="sm">Got it</Button>
      </FeatureSpotlightActions>
    </Stage>
  ),
};

const STOPS = [
  {
    label: "Pick",
    title: "Pick what to check",
    body: "Each category maps to a part of the MCP spec.",
    anchors: ["categories"],
    placement: "right",
  },
  {
    label: "Run",
    title: "See what failed and why",
    body: "Every failed check says what the spec expects and how to fix it.",
    anchors: ["results"],
    placement: "right",
  },
] as const;

/**
 * A two-stop tour you can click through. Next on the first stop plays a
 * script: the ghost cursor presses Run checks and the stage cross-fades to
 * the results. Turn on reduced motion in your OS to see it skip the cursor.
 */
export const TwoStopTour: Story = {
  ...Coachmark,
  render: function Render() {
    const rootRef = useRef<HTMLDivElement>(null);
    const cursorRef = useRef<GhostCursorHandle>(null);
    const { play, cancel, reducedMotion } = useTourPlayer(rootRef, cursorRef);
    const [index, setIndex] = useState<number | null>(0);
    const [screen, setScreen] = useState<"pick" | "results">("pick");
    const stop = index === null ? null : STOPS[index];
    const { rects, bounds } = useAnchorRects(rootRef, stop?.anchors ?? []);
    const fade = { duration: reducedMotion ? 0 : 0.45 };

    const restart = () => {
      cancel();
      setScreen("pick");
      setIndex(0);
    };
    const next = (origin: HTMLElement) => {
      if (index !== 0) {
        cancel();
        setIndex(null);
        return;
      }
      setIndex(null);
      void play(origin, async (driver) => {
        await driver.pause(250);
        await driver.moveTo("run");
        await driver.click();
        setScreen("results");
        await driver.settle();
        await driver.pause(450);
        setIndex(1);
      });
    };

    return (
      <div className="flex flex-col gap-3 p-4">
        <Button
          size="sm"
          variant="secondary"
          className="w-fit"
          onClick={restart}
        >
          Restart tour
        </Button>
        <div
          ref={rootRef}
          className="relative h-[480px] overflow-hidden rounded-lg border border-border"
        >
          <AnimatePresence initial={false}>
            <motion.div
              key={screen}
              inert
              className="absolute inset-0"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={fade}
            >
              {screen === "pick" ? <ConformanceScreen /> : <ResultsScreen />}
            </motion.div>
          </AnimatePresence>
          {stop && index !== null ? (
            <>
              <TourSpotlight rects={rects} />
              {rects[0] ? (
                <TourCoachmark
                  anchor={rects[0]}
                  bounds={bounds}
                  placement={stop.placement}
                >
                  <TourStepContent
                    labels={STOPS.map((entry) => entry.label)}
                    index={index}
                    title={stop.title}
                    body={stop.body}
                    onNext={next}
                    onSkip={() => {
                      cancel();
                      setIndex(null);
                    }}
                  />
                </TourCoachmark>
              ) : null}
            </>
          ) : null}
          <TourGhostCursor ref={cursorRef} />
        </div>
      </div>
    );
  },
};

/** One stop in both themes. */
export const LightAndDark: Story = {
  ...Coachmark,
  globals: { theme: "light" },
  render: () => (
    <ThemePair>
      <Stage anchors={["run"]} placement="right">
        <TourStepContent
          labels={LABELS}
          index={1}
          title="Run every check in one click"
          body="Conformance runs the spec's checks on your server and explains each failure."
          onNext={noop}
          onSkip={noop}
        />
      </Stage>
    </ThemePair>
  ),
};
