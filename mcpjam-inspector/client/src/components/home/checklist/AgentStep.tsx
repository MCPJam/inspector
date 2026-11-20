import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Copy } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@mcpjam/design-system/tabs";
import { copyToClipboard } from "@/lib/clipboard";
import { AGENT_SETUPS, type AgentSetup } from "./agent-setups";

const AGENT_DOCS_URL = "https://docs.mcpjam.com/hosted/mcp-server";
const COPIED_RESET_MS = 1500;

export function AgentStep({
  done,
  onCopied,
  onConfirm,
  onSkip,
}: {
  done: boolean;
  onCopied: (agent: string) => void;
  onConfirm: () => void;
  onSkip: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const copy = async (setup: AgentSetup) => {
    if (!(await copyToClipboard(setup.snippet))) return;
    onCopied(setup.id);
    setCopied(setup.id);
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(
      () => setCopied(null),
      COPIED_RESET_MS,
    );
  };

  return (
    <>
      <p className="text-sm text-muted-foreground">
        Connect your coding agent to the MCPJam MCP server so it can use your
        projects, servers and evals.
      </p>
      <Tabs defaultValue={AGENT_SETUPS[0].id} className="gap-3">
        <TabsList className="h-auto flex-wrap">
          {AGENT_SETUPS.map((setup) => (
            <TabsTrigger key={setup.id} value={setup.id} className="text-xs">
              {setup.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {AGENT_SETUPS.map((setup) => (
          <TabsContent key={setup.id} value={setup.id} className="space-y-2">
            <p className="text-xs text-muted-foreground">{setup.intro}</p>
            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted py-1.5 pr-1.5 pl-2.5">
              <code className="flex-1 py-1 font-mono text-xs break-all whitespace-pre-wrap text-foreground">
                {setup.snippetKind === "command" ? (
                  <span className="text-muted-foreground select-none">$ </span>
                ) : null}
                {setup.snippet}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2.5 text-xs"
                onClick={() => void copy(setup)}
              >
                {copied === setup.id ? (
                  <Check className="size-3.5" aria-hidden />
                ) : (
                  <Copy className="size-3.5" aria-hidden />
                )}
                {copied === setup.id ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {setup.after}{" "}
              {setup.guide ? (
                <a
                  href={setup.guide.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground underline underline-offset-2"
                >
                  {setup.guide.label}
                </a>
              ) : null}
            </p>
          </TabsContent>
        ))}
      </Tabs>
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
