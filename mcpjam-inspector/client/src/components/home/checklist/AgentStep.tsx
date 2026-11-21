import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Copy } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { copyToClipboard } from "@/lib/clipboard";

export const HOSTED_AGENT_COMMAND =
  "claude mcp add --transport http mcpjam https://mcp.mcpjam.com/mcp";
const AGENT_DOCS_URL = "https://docs.mcpjam.com/hosted/claude-connector";
const COPIED_RESET_MS = 1500;

export function AgentStep({
  done,
  onCopied,
  onConfirm,
  onSkip,
}: {
  done: boolean;
  onCopied: () => void;
  onConfirm: () => void;
  onSkip: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const copy = async () => {
    if (!(await copyToClipboard(HOSTED_AGENT_COMMAND))) return;
    onCopied();
    setCopied(true);
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(
      () => setCopied(false),
      COPIED_RESET_MS,
    );
  };

  return (
    <>
      <p className="text-sm text-muted-foreground">
        Run this in your terminal so Claude Code can use your MCPJam
        projects, servers and evals.
      </p>
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted py-1.5 pr-1.5 pl-2.5">
        <code className="flex-1 font-mono text-xs break-all text-foreground">
          <span className="text-muted-foreground select-none">$ </span>
          {HOSTED_AGENT_COMMAND}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-xs"
          onClick={() => void copy()}
        >
          {copied ? (
            <Check className="size-3.5" aria-hidden />
          ) : (
            <Copy className="size-3.5" aria-hidden />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {done ? null : (
          <>
            <Button type="button" size="sm" onClick={onConfirm}>
              I&apos;ve added it
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onSkip}>
              Skip
            </Button>
          </>
        )}
        <Button asChild variant="ghost" size="sm" className="gap-1">
          <a href={AGENT_DOCS_URL} target="_blank" rel="noreferrer">
            Setup guide
            <ArrowUpRight className="size-3.5" aria-hidden />
          </a>
        </Button>
      </div>
    </>
  );
}
