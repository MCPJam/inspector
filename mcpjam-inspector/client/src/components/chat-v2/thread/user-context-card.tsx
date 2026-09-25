/**
 * A context message the user added — a skill, a tool they ran by hand, an MCP
 * prompt's example assistant turn — shown as a compact card rather than as a
 * message they typed. Expanding it shows exactly what the model reads. Widget
 * state is for the model only and renders nothing.
 */
import {
  ChevronRight,
  MessageSquareQuote,
  SquareSlash,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type {
  UserContextBlock,
  UserContextKind,
} from "@/shared/user-context-message";

type ShownKind = Exclude<UserContextKind, "widget-state">;
type ShownBlock = UserContextBlock & { kind: ShownKind };

const PRESENTATION: Record<ShownKind, { Icon: LucideIcon; label: string }> = {
  skill: { Icon: SquareSlash, label: "Skill" },
  "skill-file": { Icon: SquareSlash, label: "Skill file" },
  "tool-run": { Icon: Wrench, label: "Ran tool" },
  "prompt-example": {
    Icon: MessageSquareQuote,
    label: "Prompt example (assistant)",
  },
};

function visibleBlocks(blocks: readonly UserContextBlock[]): ShownBlock[] {
  return blocks.filter(
    (block): block is ShownBlock => block.kind !== "widget-state",
  );
}

/** One line naming the context, for surfaces with no room for the card. */
export function describeUserContext(
  blocks: readonly UserContextBlock[],
): string | null {
  const [first, ...rest] = visibleBlocks(blocks);
  if (!first) return null;
  const files = rest.filter((block) => block.kind === "skill-file").length;
  const label = PRESENTATION[first.kind].label;
  return `${label}: ${first.subject}${files > 0 ? ` (+${files} files)` : ""}`;
}

export function UserContextCard({
  blocks,
}: {
  blocks: readonly UserContextBlock[];
}) {
  const shown = visibleBlocks(blocks);
  const [first, ...rest] = shown;
  if (!first) return null;
  const { Icon, label } = PRESENTATION[first.kind];
  const files = rest.filter((block) => block.kind === "skill-file").length;
  const content = shown.map((block) => block.body.trim()).join("\n\n");

  return (
    <div
      className="flex w-full min-w-0 justify-end"
      data-testid="user-context-card"
      data-context-kind={first.kind}
    >
      <details
        className="group/context max-w-[min(100%,48rem)] min-w-0 rounded-md border border-border bg-muted/50 text-xs"
        // An example turn is short and read as part of the prompt; skills and
        // tool output are long, and the tool card already shows the output.
        open={first.kind === "prompt-example"}
      >
        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1 marker:content-none">
          <Icon size={12} className="shrink-0 text-primary" />
          <span className="shrink-0 text-muted-foreground">{label}</span>
          <span className="min-w-0 truncate font-medium text-foreground">
            {first.subject}
          </span>
          {files > 0 ? (
            <span className="shrink-0 rounded-full bg-primary/20 px-1.5 py-0.5 text-[10px] text-primary">
              +{files} files
            </span>
          ) : null}
          <ChevronRight
            size={12}
            className="shrink-0 text-muted-foreground transition-transform group-open/context:rotate-90"
          />
        </summary>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border-t border-border px-2 py-2 font-mono text-[11px] leading-relaxed text-foreground/80">
          {content}
        </pre>
      </details>
    </div>
  );
}
