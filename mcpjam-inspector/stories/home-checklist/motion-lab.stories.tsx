import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Progress } from "@mcpjam/design-system/progress";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
import { cn } from "@mcpjam/design-system/cn";
import { getConnectionStatusMeta } from "@/components/connection/server-card-utils";
import { ChecklistStepRow } from "@/components/home/checklist/ChecklistStepRow";

/**
 * Motion lab for the Home setup checklist (BA-10). Replays the three moments
 * the checklist animates, at real speed or slowed down, with the shipped
 * behavior ("Current") beside the options. Exploration only: nothing here is
 * wired into Home until one option is chosen.
 */
const meta = {
  title: "Explorations/Home checklist motion",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const STEPS = [
  "Connect your server",
  "Try it in Playground",
  "Add MCPJam to your coding agent",
  "Check your server",
  "Run your first eval",
];
const SURFACES = [
  "Home",
  "Playground",
  "Your coding agent",
  "Conformance",
  "Evaluate",
];
const EASE_OUT = [0, 0, 0.2, 1] as const;

function useLab() {
  const [speed, setSpeed] = useState("1");
  const [run, setRun] = useState(0);
  const slow = Number(speed);
  /** Milliseconds, stretched by the slow-motion factor. */
  const ms = useCallback((base: number) => base * slow, [slow]);
  const controls = (
    <div className="flex flex-wrap items-center gap-3 border-b border-border bg-background px-6 py-3">
      <Button size="sm" onClick={() => setRun((n) => n + 1)}>
        Replay all
      </Button>
      <span className="text-xs text-muted-foreground">Speed</span>
      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        value={speed}
        onValueChange={(v) => v && setSpeed(v)}
      >
        <ToggleGroupItem value="1">1×</ToggleGroupItem>
        <ToggleGroupItem value="4">¼×</ToggleGroupItem>
        <ToggleGroupItem value="10">⅒×</ToggleGroupItem>
      </ToggleGroup>
      <span className="text-xs text-muted-foreground">
        Toggle your OS "reduce motion" setting to check the fallback.
      </span>
    </div>
  );
  return { controls, run, ms };
}

function Variant({
  name,
  note,
  current,
  children,
}: {
  name: string;
  note: string;
  current?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div>
        <p className="text-sm font-medium text-foreground">
          {name}
          {current ? (
            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              Shipped
            </span>
          ) : null}
        </p>
        <p className="text-xs text-muted-foreground">{note}</p>
      </div>
      <div className="min-h-32">{children}</div>
    </section>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return (
    <div className="grid gap-4 p-6 md:grid-cols-2 xl:grid-cols-4">
      {children}
    </div>
  );
}

/* ---------- 1. Step 1 auto-connect ---------- */

type ConnectPhase = "typed" | "connecting" | "connected";
type ConnectStyle = "cut" | "fade" | "slide" | "height";

function useConnectPhase(run: number, ms: (n: number) => number) {
  const [phase, setPhase] = useState<ConnectPhase>("typed");
  useEffect(() => {
    setPhase("typed");
    const a = window.setTimeout(() => setPhase("connecting"), ms(400));
    const b = window.setTimeout(() => setPhase("connected"), ms(1800));
    return () => {
      window.clearTimeout(a);
      window.clearTimeout(b);
    };
  }, [run, ms]);
  return phase;
}

function ConnectingRow() {
  const meta = getConnectionStatusMeta("connecting");
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <meta.Icon className={meta.iconClassName} aria-hidden />
      <span className="flex-1">{meta.label}</span>
      <Button type="button" variant="ghost" size="sm">
        Cancel
      </Button>
    </div>
  );
}

function ConnectedBlock() {
  const meta = getConnectionStatusMeta("connected");
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        <span
          className={cn("size-2 rounded-full", meta.indicatorClassName)}
          aria-hidden
        />
        <span className="text-foreground">Connected to stateless-test</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm">Confirm</Button>
        <Button variant="ghost" size="sm">
          Use a different server
        </Button>
      </div>
    </div>
  );
}

function ConnectDemo({
  style,
  run,
  ms,
}: {
  style: ConnectStyle;
  run: number;
  ms: (n: number) => number;
}) {
  const phase = useConnectPhase(run, ms);
  const body =
    phase === "connecting" ? (
      <ConnectingRow />
    ) : phase === "connected" ? (
      <ConnectedBlock />
    ) : null;
  const motionProps = {
    fade: {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
    },
    slide: {
      initial: { opacity: 0, y: 4 },
      animate: { opacity: 1, y: 0 },
      exit: { opacity: 0, y: -4 },
    },
    height: {
      initial: { opacity: 0, height: 0 },
      animate: { opacity: 1, height: "auto" },
      exit: { opacity: 0, height: 0 },
    },
  } as const;
  return (
    <div className="space-y-3">
      <Input
        readOnly
        value="https://stateless-test.example.com/mcp"
        aria-label="Server URL"
      />
      {style === "cut" ? (
        body
      ) : (
        <AnimatePresence
          mode={style === "height" ? "sync" : "wait"}
          initial={false}
        >
          {body ? (
            <motion.div
              key={phase}
              {...motionProps[style]}
              transition={{
                duration: ms(style === "height" ? 220 : 160) / 1000,
                ease: EASE_OUT,
              }}
              className={style === "height" ? "overflow-hidden" : undefined}
            >
              {body}
            </motion.div>
          ) : null}
        </AnimatePresence>
      )}
    </div>
  );
}

export const AutoConnect: Story = {
  name: "1. Step 1 auto-connect",
  render: function Render() {
    const { controls, run, ms } = useLab();
    return (
      <div>
        {controls}
        <Grid>
          <Variant
            current
            name="Cut"
            note="Status row swaps in place; the Confirm block pops in and pushes the layout down."
          >
            <ConnectDemo style="cut" run={run} ms={ms} />
          </Variant>
          <Variant
            name="Fade 160 ms"
            note="Old status fades out, new one fades in. Layout still jumps when Confirm appears."
          >
            <ConnectDemo style="fade" run={run} ms={ms} />
          </Variant>
          <Variant
            name="Fade + 4 px rise"
            note="Same as fade, with a small upward settle."
          >
            <ConnectDemo style="slide" run={run} ms={ms} />
          </Variant>
          <Variant
            name="Height + fade 220 ms"
            note="Panel grows smoothly to fit the Confirm block, so nothing below jumps."
          >
            <ConnectDemo style="height" run={run} ms={ms} />
          </Variant>
        </Grid>
      </div>
    );
  },
};

/* ---------- 2. Progress bar ---------- */

type BarStyle = { duration: number; ease: string; fromPrevious: boolean };

function ProgressDemo({
  bar,
  returning,
  run,
  ms,
}: {
  bar: BarStyle;
  returning: boolean;
  run: number;
  ms: (n: number) => number;
}) {
  const before = 1;
  const after = 2;
  const [done, setDone] = useState(before);
  const [mounted, setMounted] = useState(!returning);
  useEffect(() => {
    if (returning) {
      // Coming back from Playground: Home remounts with the step already done.
      setMounted(false);
      setDone(bar.fromPrevious ? before : after);
      const show = window.setTimeout(() => setMounted(true), ms(500));
      const grow = bar.fromPrevious
        ? window.setTimeout(() => setDone(after), ms(500) + 120)
        : undefined;
      return () => {
        window.clearTimeout(show);
        if (grow) window.clearTimeout(grow);
      };
    }
    setDone(before);
    const t = window.setTimeout(() => setDone(after), ms(600));
    return () => window.clearTimeout(t);
  }, [run, returning, bar.fromPrevious, ms]);
  const style = {
    "--lab-bar-ms": `${ms(bar.duration)}ms`,
    "--lab-bar-ease": bar.ease,
    "--lab-row-ms": `${ms(300)}ms`,
  } as CSSProperties;
  if (!mounted) {
    return <p className="text-xs text-muted-foreground">On Playground…</p>;
  }
  return (
    <div className="lab-bar space-y-3" style={style}>
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">{done} of 5 done</span>
        <Progress
          value={(done / 5) * 100}
          aria-label="Setup progress"
          tone="success"
          pace="gradual"
          className="h-1.5 w-32 bg-muted"
        />
      </div>
      <ul>
        {STEPS.slice(0, 2).map((title, i) => (
          <ChecklistStepRow
            key={title}
            index={i + 1}
            title={title}
            surface={SURFACES[i]}
            done={i < done}
            selected={i === 1}
            onSelect={() => undefined}
          />
        ))}
      </ul>
    </div>
  );
}

const BAR_STYLES: {
  name: string;
  note: string;
  current?: boolean;
  bar: BarStyle;
}[] = [
  {
    name: "700 ms ease-out",
    note: 'Shipped: Progress pace="gradual". Returning from another page shows the new value with no motion.',
    current: true,
    bar: {
      duration: 700,
      ease: "cubic-bezier(0, 0, 0.2, 1)",
      fromPrevious: false,
    },
  },
  {
    name: "700 ms, animate on return",
    note: "Home remembers the last count it showed and grows from there after navigating back.",
    bar: {
      duration: 700,
      ease: "cubic-bezier(0, 0, 0.2, 1)",
      fromPrevious: true,
    },
  },
  {
    name: "400 ms ease-out, on return",
    note: "Snappier; the fill ends with the row check.",
    bar: {
      duration: 400,
      ease: "cubic-bezier(0, 0, 0.2, 1)",
      fromPrevious: true,
    },
  },
  {
    name: "900 ms soft overshoot, on return",
    note: "Small overshoot that settles; more celebratory.",
    bar: {
      duration: 900,
      ease: "cubic-bezier(0.34, 1.3, 0.64, 1)",
      fromPrevious: true,
    },
  },
];

function ProgressStory({ returning }: { returning: boolean }) {
  const { controls, run, ms } = useLab();
  return (
    <div>
      <style>{`.lab-bar [data-slot="progress-indicator"]{transition-duration:var(--lab-bar-ms)!important;transition-timing-function:var(--lab-bar-ease)!important}.lab-bar li button>span:first-child{transition-duration:var(--lab-row-ms)!important}`}</style>
      {controls}
      <Grid>
        {BAR_STYLES.map((v) => (
          <Variant key={v.name} name={v.name} note={v.note} current={v.current}>
            <ProgressDemo bar={v.bar} returning={returning} run={run} ms={ms} />
          </Variant>
        ))}
      </Grid>
    </div>
  );
}

export const ProgressOnHome: Story = {
  name: "2a. Progress: step finishes on Home",
  render: () => <ProgressStory returning={false} />,
};

export const ProgressOnReturn: Story = {
  name: "2b. Progress: back from another page",
  render: () => <ProgressStory returning />,
};

/* ---------- 3. 5 of 5 → today's Home ---------- */

type FinishStyle = "cut" | "crossfade" | "collapse" | "celebrate";

function TodaysHome() {
  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <p className="text-sm font-medium text-foreground">Today's Home</p>
      <div className="grid grid-cols-3 gap-2">
        {["Servers", "Recent runs", "Evals"].map((label) => (
          <div
            key={label}
            className="h-14 rounded-md bg-muted p-2 text-xs text-muted-foreground"
          >
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}

function FinishedChecklist({ celebrate }: { celebrate: boolean }) {
  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">5 of 5 done</span>
        <Progress
          value={100}
          aria-label="Setup progress"
          tone="success"
          className="h-1.5 w-32 bg-muted"
        />
      </div>
      {celebrate ? (
        <p className="text-sm font-medium text-success">You're all set.</p>
      ) : null}
      <ul>
        {STEPS.map((title, i) => (
          <ChecklistStepRow
            key={title}
            index={i + 1}
            title={title}
            surface={SURFACES[i]}
            done
            selected={false}
            onSelect={() => undefined}
          />
        ))}
      </ul>
    </div>
  );
}

function FinishDemo({
  style,
  run,
  ms,
}: {
  style: FinishStyle;
  run: number;
  ms: (n: number) => number;
}) {
  const [handedBack, setHandedBack] = useState(false);
  useEffect(() => {
    setHandedBack(false);
    const t = window.setTimeout(() => setHandedBack(true), ms(1500));
    return () => window.clearTimeout(t);
  }, [run, ms]);
  const view = handedBack ? (
    <TodaysHome />
  ) : (
    <FinishedChecklist celebrate={style === "celebrate"} />
  );
  if (style === "cut") return view;
  const out =
    style === "collapse"
      ? { opacity: 0, height: 0, scale: 0.98 }
      : { opacity: 0 };
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={handedBack ? "home" : "checklist"}
        initial={{ opacity: 0, y: style === "crossfade" ? 0 : 6 }}
        animate={{ opacity: 1, y: 0, height: "auto", scale: 1 }}
        exit={out}
        transition={{
          duration: ms(style === "collapse" ? 280 : 220) / 1000,
          ease: EASE_OUT,
        }}
        className="overflow-hidden"
      >
        {view}
      </motion.div>
    </AnimatePresence>
  );
}

export const FinishToHome: Story = {
  name: "3. 5 of 5 → today's Home",
  render: function Render() {
    const { controls, run, ms } = useLab();
    return (
      <div>
        {controls}
        <Grid>
          <Variant
            current
            name="Hold 1.5 s, then cut"
            note="Shipped: 5 of 5 stays up for 1.5 s, then today's Home replaces it in one frame."
          >
            <FinishDemo style="cut" run={run} ms={ms} />
          </Variant>
          <Variant
            name="Crossfade 220 ms"
            note="Checklist fades out, today's Home fades in."
          >
            <FinishDemo style="crossfade" run={run} ms={ms} />
          </Variant>
          <Variant
            name="Collapse, then rise"
            note="Checklist shrinks away (280 ms); today's Home settles in from 6 px below."
          >
            <FinishDemo style="collapse" run={run} ms={ms} />
          </Variant>
          <Variant
            name="“You're all set” + rise"
            note="Adds a success line during the hold, then fades through to today's Home."
          >
            <FinishDemo style="celebrate" run={run} ms={ms} />
          </Variant>
        </Grid>
      </div>
    );
  },
};
