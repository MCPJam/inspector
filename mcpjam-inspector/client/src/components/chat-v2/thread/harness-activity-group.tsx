import { useState, type ReactNode } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import type { DynamicToolUIPart, ToolUIPart, UITools } from "ai";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { cn } from "@/lib/chat-utils";
import { getToolServerId, type ToolServerMap } from "@/lib/apis/mcp-tools-api";
import { readMcpToolOriginServerId } from "@/shared/mcp-tool-origin-metadata";
import { useHarnessLiveOutput } from "@/stores/harness-live-output-store";
import {
  describeHarnessToolStep,
  isHarnessActivityToolName,
  summarizeHarnessActivity,
} from "./harness-tool-steps";
// The package helpers directly, not `./thread-helpers`: MessageView imports
// this module, and its tests stub that file down to the two helpers it uses.
import {
  getToolInfo,
  isDynamicTool,
  isToolPart,
  type ToolState,
} from "@mcpjam/chat-ui/thread-helpers";

type AnyToolPart = ToolUIPart<UITools> | DynamicToolUIPart;

/**
 * Whether a part is a harness built-in's call (a command, a read, an edit, a
 * search) that folds into an activity row. Never an MCP server's tool, even one
 * that happens to share a built-in's name, never a call waiting on approval,
 * and never one a render override claims.
 */
export function isHarnessActivityPart(
  part: unknown,
  toolServerMap: ToolServerMap,
  hasRenderOverride: (toolCallId: string) => boolean,
): part is AnyToolPart {
  if (!isToolPart(part as never) && !isDynamicTool(part)) return false;
  const tool = part as AnyToolPart & {
    callProviderMetadata?: unknown;
    providerMetadata?: unknown;
    providerOptions?: unknown;
  };
  const info = getToolInfo(tool);
  if (!isHarnessActivityToolName(info.toolName)) return false;
  if (info.toolState === "approval-requested") return false;
  if (info.toolCallId && hasRenderOverride(info.toolCallId)) return false;
  return (
    readMcpToolOriginServerId(tool.callProviderMetadata) === undefined &&
    readMcpToolOriginServerId(tool.providerMetadata) === undefined &&
    readMcpToolOriginServerId(tool.providerOptions) === undefined &&
    getToolServerId(info.toolName, toolServerMap) === undefined
  );
}

function isSettled(state: ToolState | undefined): boolean {
  return (
    state === "output-available" ||
    state === "output-error" ||
    state === "output-denied"
  );
}

function LiveOutputTail({ toolCallId }: { toolCallId: string | undefined }) {
  const output = useHarnessLiveOutput(toolCallId);
  if (!output) return null;
  const tail = output.trimEnd().split("\n").slice(-6).join("\n");
  if (!tail) return null;
  return (
    <pre
      className="mt-1 ml-5 max-h-28 overflow-hidden whitespace-pre-wrap break-words rounded-md bg-muted/40 px-2 py-1 font-mono text-[11px] leading-4 text-muted-foreground"
      data-testid="harness-live-output"
    >
      {tail}
    </pre>
  );
}

/**
 * A run of a harness's built-in tool calls as one row: "Ran 2 commands, read
 * 3 files". While a call runs, the row names it and shows its live output;
 * open it to see each call's card, which says what that call did.
 */
export function HarnessActivityGroup({
  parts,
  renderPart,
}: {
  parts: AnyToolPart[];
  renderPart: (part: AnyToolPart) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const infos = parts.map((part) => getToolInfo(part));
  const current = [...infos]
    .reverse()
    .find((info) => !isSettled(info.toolState));
  const failures = infos.filter(
    (info) => info.toolState === "output-error",
  ).length;
  const summary = summarizeHarnessActivity(
    infos.map((info) => ({ toolName: info.toolName, input: info.input })),
  );
  const currentLabel = current
    ? describeHarnessToolStep(current.toolName, current.input)
    : undefined;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="text-xs"
      data-testid="harness-activity-group"
    >
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 text-left text-muted-foreground hover:text-foreground">
        {current ? (
          <Loader2
            className="h-3.5 w-3.5 shrink-0 animate-spin"
            aria-hidden="true"
          />
        ) : (
          <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0 truncate">
          {currentLabel ? (
            <>
              <span className="text-foreground">{currentLabel.verb}</span>
              {currentLabel.detail && (
                <span
                  className={cn("ml-1.5", currentLabel.code && "font-mono")}
                >
                  {currentLabel.detail}
                </span>
              )}
            </>
          ) : (
            // Muted: finished legwork recedes behind the reply's text.
            <span>{summary}</span>
          )}
        </span>
        {(current ? parts.length > 1 : false) || failures > 0 ? (
          <span className="shrink-0">
            {[
              current && parts.length > 1 ? `${parts.length} steps` : undefined,
              failures > 0 ? `${failures} failed` : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        ) : null}
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 transition-transform duration-150",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      {current && <LiveOutputTail toolCallId={current.toolCallId} />}
      <CollapsibleContent>
        <div className="mt-2 ml-[6px] space-y-2 border-l border-border/60 pl-3">
          {parts.map((part, index) => (
            <div key={infos[index]!.toolCallId ?? `call-${index}`}>
              {renderPart(part)}
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export type HarnessActivitySegment<P> =
  | { kind: "part"; part: P; index: number }
  | { kind: "activity"; parts: P[]; key: string };

/**
 * A step's parts, with each run of activity calls gathered into one segment.
 * An empty text part (a block the runtime opened and closed with nothing in
 * it) does not break a run. Everything else keeps its own place.
 */
export function segmentHarnessActivity<P>(
  parts: P[],
  isActivity: (part: P) => boolean,
): HarnessActivitySegment<P>[] {
  const segments: HarnessActivitySegment<P>[] = [];
  let run: P[] | undefined;
  parts.forEach((part, index) => {
    if (isActivity(part)) {
      if (!run) {
        const id = (part as { toolCallId?: unknown }).toolCallId;
        run = [];
        segments.push({
          kind: "activity",
          parts: run,
          key: typeof id === "string" && id ? id : `idx-${index}`,
        });
      }
      run.push(part);
      return;
    }
    const empty =
      (part as { type?: unknown }).type === "text" &&
      !String((part as { text?: unknown }).text ?? "").trim();
    if (empty && run) return;
    run = undefined;
    segments.push({ kind: "part", part, index });
  });
  return segments;
}
