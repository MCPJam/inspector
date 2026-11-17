import { useEffect, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@mcpjam/design-system/tabs";
import { cn } from "@mcpjam/design-system/cn";
import { track } from "@/lib/analytics";
import { copyToClipboard } from "@/lib/clipboard";
import { getHostLogoSrc } from "@/lib/host-ui-metadata";

const AGENT_LOGOS = [
  { hostId: "claude", label: "Claude" },
  { hostId: "codex", label: "Codex" },
  { hostId: "cursor", label: "Cursor" },
] as const;

const CLI_STEPS = [
  { id: "install", label: "Install", command: "npm i -g @mcpjam/cli" },
  {
    id: "login",
    label: "Sign in to your account",
    command: "mcpjam cloud login",
  },
] as const;

const CLI_LINKS = [
  {
    id: "reference",
    label: "All commands",
    hint: "Docs",
    href: "https://docs.mcpjam.com/cli/reference",
  },
] as const;

// Matches the trigger's `lg:inline-flex`; below it the trigger is hidden.
const TRIGGER_VISIBLE_QUERY = "(min-width: 1024px)";
const TRIGGER_LABEL = "Onboard your agent to MCPJam";
const COPIED_RESET_MS = 1500;

function CommandRow({ id, command }: { id: string; command: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const onCopy = async () => {
    const ok = await copyToClipboard(command);
    track("onboard_agent_command_copied", {
      location: "header",
      command: id,
      copied: ok,
    });
    if (!ok) return;
    setCopied(true);
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(
      () => setCopied(false),
      COPIED_RESET_MS,
    );
  };

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted py-1.5 pr-1.5 pl-2.5">
      <code className="flex-1 font-mono text-xs break-all text-foreground">
        <span className="text-muted-foreground select-none">$ </span>
        {command}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2.5 text-xs"
        aria-label={`Copy ${command}`}
        onClick={onCopy}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

export function OnboardAgentButton() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const mql = window.matchMedia(TRIGGER_VISIBLE_QUERY);
    const onChange = () => {
      if (!mql.matches) setOpen(false);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [open]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) track("onboard_agent_opened", { location: "header" });
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="secondary"
              size="sm"
              aria-label={TRIGGER_LABEL}
              // Below 2xl only the logos show, so the server selector keeps room.
              className={cn(
                "hidden gap-2 px-1.5 lg:inline-flex 2xl:pl-2.5",
                open && "bg-chrome-control-hover",
              )}
            >
              <span className="hidden 2xl:inline">{TRIGGER_LABEL}</span>
              <span className="flex items-center gap-1" aria-hidden>
                {AGENT_LOGOS.map(({ hostId, label }) => (
                  <img
                    key={hostId}
                    src={getHostLogoSrc(hostId)}
                    alt={label}
                    className="size-4.5 rounded object-contain"
                  />
                ))}
              </span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="2xl:hidden">
          {TRIGGER_LABEL}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[400px] overflow-hidden rounded-xl p-0"
      >
        <Tabs defaultValue="cli" className="gap-0">
          <TabsList
            aria-label="Onboard your agent"
            className="h-auto w-full justify-start rounded-none border-b border-border bg-transparent p-0 px-2 pt-1.5"
          >
            <TabsTrigger
              value="cli"
              className="h-8 flex-none rounded-none border-0 border-b-2 border-transparent px-2.5 text-card-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none dark:text-card-foreground dark:data-[state=active]:border-primary dark:data-[state=active]:bg-transparent"
            >
              MCPJam CLI
            </TabsTrigger>
          </TabsList>
          <TabsContent value="cli">
            <div className="flex flex-col gap-2.5 px-3.5 py-3">
              <p className="text-sm text-muted-foreground">
                Have your coding agent drive everything in MCPJam.
              </p>
              {CLI_STEPS.map(({ id, label, command }) => (
                <div key={id} className="flex flex-col gap-1.5">
                  <span className="text-xs text-muted-foreground">{label}</span>
                  <CommandRow id={id} command={command} />
                </div>
              ))}
            </div>
            {CLI_LINKS.map(({ id, label, hint, href }) => (
              <a
                key={id}
                href={href}
                target="_blank"
                rel="noreferrer"
                onClick={() =>
                  track("onboard_agent_link_clicked", {
                    location: "header",
                    link: id,
                  })
                }
                className="flex items-center gap-2.5 border-t border-border px-3.5 py-2.5 text-sm text-card-foreground hover:bg-accent"
              >
                <span className="flex-1">{label}</span>
                <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
                  {hint}
                  <ArrowUpRight className="size-3" aria-hidden />
                </span>
              </a>
            ))}
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}
