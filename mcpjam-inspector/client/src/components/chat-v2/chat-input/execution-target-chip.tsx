import { Cloud, Laptop, Loader2, TriangleAlert } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { cn } from "@mcpjam/design-system/cn";
import type { LocalHarnessPhase } from "@/hooks/useLocalHarnessTarget";

/**
 * Where this turn's Claude Code agent will run — an indicator, or a picker.
 *
 * ── Why it is usually not a picker ───────────────────────────────────────
 * On a normal npx or Electron installation there is no choice to make. "Cloud"
 * needs the computers data plane, which a local Inspector does not have; the
 * hosted web app can never run local at all. So the Hosted⇄Native *choice*
 * almost never exists, and a two-option selector on a machine with one option
 * is a control that asks a question with one answer.
 *
 * `hostedAvailable` decides which face this shows, and it is deliberately
 * `boolean | null`: null means the server has not answered, and neither
 * rendering is honest then. An unknown target is a loading state, never an
 * invented default.
 *
 * ── Vocabulary ───────────────────────────────────────────────────────────
 * "This machine" / "Cloud", matching `RailEngineChip` — the other place in the
 * product that says where work runs. Two different phrasings for the same fact
 * is how a user ends up believing they are two different facts.
 */
export type ExecutionTargetChipData = {
  target: "hosted" | "local-native" | null;
  phase: LocalHarnessPhase;
  /** Download progress, 0-100, while `phase` is `installing`. */
  percent?: number;
  /** `~/code/project`. Display only; never an absolute path. */
  displayRoot?: string;
  /** Null ⇒ unknown. Only `true` offers a choice. */
  hostedAvailable: boolean | null;
  onSelect: (target: "hosted" | "local-native") => void;
  onOpenDetails: () => void;
};

const PILL_CLASS =
  "inline-flex items-center gap-1 rounded-full border border-border/60 " +
  "bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground " +
  "transition-colors hover:bg-muted/70 focus-visible:outline-none " +
  "focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60";

/** What the chip says for each phase, and whether it reads as a problem. */
function chipFace(data: ExecutionTargetChipData): {
  label: string;
  icon: typeof Laptop;
  tone: "normal" | "busy" | "attention";
  title: string;
} {
  // Anything that is not an explicit local target runs hosted, and the phase
  // labels below all assume local — so falling through to them with no target
  // is how the chip came to say "This machine" over a turn bound for the
  // cloud. `hostedAvailable === true` with nothing requested is exactly that
  // case: a machine that HAS a cloud target and no choice recorded.
  if (
    data.target === "hosted" ||
    (data.target === null && data.hostedAvailable === true)
  ) {
    return {
      label: "Cloud",
      icon: Cloud,
      tone: "normal",
      title: "This host's Claude Code runs in a cloud computer",
    };
  }
  switch (data.phase) {
    case "loading":
      return {
        label: "Checking…",
        icon: Loader2,
        tone: "busy",
        // No target is claimed while the answer is unknown. Guessing here is
        // how a chip ends up saying "This machine" on a machine that cannot.
        title: "Checking where Claude Code can run",
      };
    case "installing":
      return {
        label:
          data.percent === undefined
            ? "Setting up…"
            : `Setting up · ${data.percent}%`,
        icon: Loader2,
        tone: "busy",
        title: "Downloading and verifying the Claude Code runtime",
      };
    case "authorizing":
      return {
        label: "Authorizing…",
        icon: Loader2,
        tone: "busy",
        title: "Requesting authorization to run on this machine",
      };
    case "failed":
    case "interrupted":
      return {
        label: "Setup failed",
        icon: TriangleAlert,
        tone: "attention",
        title: "Claude Code setup did not finish — open for details",
      };
    case "needs-signin":
      return {
        label: "Sign in",
        icon: TriangleAlert,
        tone: "attention",
        title: "Sign in to run Claude Code on this machine",
      };
    case "needs-workspace":
    case "needs-consent":
      return {
        label: "This machine",
        icon: Laptop,
        tone: "attention",
        title: "Not authorized yet — open to choose a folder and allow it",
      };
    case "ready":
      return {
        label: "This machine",
        icon: Laptop,
        tone: "normal",
        title: data.displayRoot
          ? `Claude Code runs here, in ${data.displayRoot}`
          : "Claude Code runs on this machine",
      };
    case "unavailable":
    default:
      return {
        label: "Cloud",
        icon: Cloud,
        tone: "normal",
        title: "This machine can't run Claude Code — the turn runs hosted",
      };
  }
}

export function ExecutionTargetChip(props: ExecutionTargetChipData) {
  const face = chipFace(props);
  const Icon = face.icon;
  const body = (
    <>
      <Icon
        className={cn("size-3", face.tone === "busy" && "animate-spin")}
        aria-hidden
      />
      {face.label}
    </>
  );
  const toneClass =
    face.tone === "attention"
      ? "border-warning/50 text-foreground"
      : undefined;

  // ONE offerable target ⇒ an indicator, not a menu. The click still opens the
  // dialog, because "where does this run" and "authorize it" are the same
  // question when there is only one answer.
  if (props.hostedAvailable !== true) {
    return (
      <button
        type="button"
        data-testid="execution-target-chip"
        data-phase={props.phase}
        className={cn(PILL_CLASS, toneClass)}
        title={face.title}
        onClick={props.onOpenDetails}
      >
        {body}
      </button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="execution-target-chip"
          data-phase={props.phase}
          className={cn(PILL_CLASS, toneClass)}
          title={face.title}
        >
          {body}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52">
        <DropdownMenuItem onSelect={() => props.onSelect("local-native")}>
          <Laptop className="size-3.5" aria-hidden />
          <span className="flex flex-col">
            <span>This machine</span>
            <span className="text-[11px] text-muted-foreground">
              {props.displayRoot ?? "Choose a folder"}
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => props.onSelect("hosted")}>
          <Cloud className="size-3.5" aria-hidden />
          <span className="flex flex-col">
            <span>Cloud</span>
            <span className="text-[11px] text-muted-foreground">
              A disposable computer MCPJam runs
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={props.onOpenDetails}>
          Details…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
