import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Bot, Check, ChevronDown, Copy } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { copyToClipboard } from "@/lib/clipboard";
import {
  AGENT_CLIENT_GROUPS,
  AGENT_CLIENTS,
  AGENT_ONBOARD_PROMPT,
  type AgentClient,
} from "./agent-setups";

const AGENT_DOCS_URL = "https://docs.mcpjam.com/hosted/mcp-server";
const COPIED_RESET_MS = 1500;

export function AgentStep({
  done,
  initialClient = AGENT_CLIENTS[0].id,
  onCopied,
  onConfirm,
  onSkip,
}: {
  done: boolean;
  initialClient?: string;
  onCopied: (agent: string) => void;
  onConfirm: () => void;
  onSkip: () => void;
}) {
  const [clientId, setClientId] = useState(initialClient);
  const client =
    AGENT_CLIENTS.find((item) => item.id === clientId) ?? AGENT_CLIENTS[0];
  const [copied, setCopied] = useState<string | null>(null);
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const copy = async (text: string) => {
    if (!(await copyToClipboard(text))) return;
    onCopied(client.id);
    setCopied(client.id);
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(
      () => setCopied(null),
      COPIED_RESET_MS,
    );
  };

  return (
    <>
      <p className="text-sm text-muted-foreground">
        Connect your agent to the MCPJam MCP server so it can use your projects,
        servers and evals.
      </p>
      <div className="rounded-lg border border-border bg-card">
        <div className="space-y-2 p-4">
          <div>
            <p className="text-sm font-medium text-foreground">Your agent</p>
            <p className="text-xs text-muted-foreground">
              Pick one to see its setup steps.
            </p>
          </div>
          <ClientPicker client={client} onSelect={setClientId} />
        </div>
        <div
          role="region"
          aria-label={`${client.label} setup`}
          className="space-y-4 border-t border-border p-4"
        >
          <ClientSetup
            client={client}
            copied={copied === client.id}
            onCopy={(text) => void copy(text)}
          />
        </div>
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

function ClientIcon({ client }: { client: AgentClient }) {
  if (client.icons.length === 0) {
    return <Bot className="size-4" aria-hidden />;
  }
  return (
    <span className="flex shrink-0 -space-x-1">
      {client.icons.map((icon) => (
        <img key={icon} src={icon} alt="" className="size-4 rounded-sm" />
      ))}
    </span>
  );
}

function ClientPicker({
  client,
  onSelect,
}: {
  client: AgentClient;
  onSelect: (id: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full justify-start gap-2"
          aria-label={`Agent: ${client.label}`}
        >
          <ClientIcon client={client} />
          {client.label}
          <ChevronDown
            className="ml-auto size-4 text-muted-foreground"
            aria-hidden
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-(--radix-dropdown-menu-trigger-width)"
      >
        {AGENT_CLIENT_GROUPS.map((group, i) => (
          <Fragment key={group.label ?? group.clients[0].id}>
            {i > 0 ? <DropdownMenuSeparator /> : null}
            {group.label ? (
              <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
                {group.label}
              </DropdownMenuLabel>
            ) : null}
            {group.clients.map((item) => (
              <DropdownMenuItem
                key={item.id}
                onSelect={() => onSelect(item.id)}
              >
                <ClientIcon client={item} />
                {item.label}
                {item.id === client.id ? (
                  <Check className="ml-auto size-4" aria-hidden />
                ) : null}
              </DropdownMenuItem>
            ))}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

function GuideLink({ guide }: { guide: { label: string; url: string } }) {
  return (
    <a
      href={guide.url}
      target="_blank"
      rel="noreferrer"
      className="text-foreground underline underline-offset-2"
    >
      {guide.label}
    </a>
  );
}

function ClientSetup({
  client,
  copied,
  onCopy,
}: {
  client: AgentClient;
  copied: boolean;
  onCopy: (text: string) => void;
}) {
  // The desktop app only opens http(s) links, so editor deep links can't open there.
  const canOpenEditorLinks = !window.electronAPI;
  switch (client.kind) {
    case "command":
      return (
        <Section
          title="Run this in your terminal"
          description={
            <>
              {client.after} <GuideLink guide={client.guide} />
            </>
          }
        >
          <Snippet
            text={client.command}
            command
            copied={copied}
            onCopy={() => onCopy(client.command)}
          />
        </Section>
      );
    case "install":
      return (
        <>
          {canOpenEditorLinks ? (
            <Section
              title="One-click setup"
              description={`Opens ${client.label} to install the MCPJam server, then click Install.`}
            >
              <Button asChild size="sm" variant="outline" className="gap-2">
                <a href={client.install}>
                  <ClientIcon client={client} />
                  Add to {client.label}
                  <ArrowUpRight
                    className="size-3.5 text-muted-foreground"
                    aria-hidden
                  />
                </a>
              </Button>
            </Section>
          ) : null}
          <Section
            title={canOpenEditorLinks ? "Or add it by hand" : "Add it by hand"}
            description={
              <>
                {client.manual} {client.after}{" "}
                <GuideLink guide={client.guide} />
              </>
            }
          >
            <Snippet
              text={client.snippet}
              copied={copied}
              onCopy={() => onCopy(client.snippet)}
            />
          </Section>
        </>
      );
    case "plugin":
      return (
        <Section
          title="Add the MCPJam plugin"
          description="Works in ChatGPT and the Codex app, and signs in with your MCPJam account."
        >
          <Button asChild size="sm" variant="outline" className="gap-2">
            <a href={client.url} target="_blank" rel="noreferrer">
              <ClientIcon client={client} />
              Open the plugin
              <ArrowUpRight
                className="size-3.5 text-muted-foreground"
                aria-hidden
              />
            </a>
          </Button>
        </Section>
      );
    case "prompt":
      return (
        <Section
          title="Paste this prompt into your agent"
          description="It sets up MCPJam for that agent, then tests your server."
        >
          <Snippet
            text={AGENT_ONBOARD_PROMPT}
            copied={copied}
            onCopy={() => onCopy(AGENT_ONBOARD_PROMPT)}
          />
        </Section>
      );
  }
}

function Snippet({
  text,
  command = false,
  copied,
  onCopy,
}: {
  text: string;
  command?: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-muted py-1.5 pr-1.5 pl-2.5">
      <code className="flex-1 py-1 font-mono text-xs break-all whitespace-pre-wrap text-foreground">
        {command ? (
          <span className="text-muted-foreground select-none">$ </span>
        ) : null}
        {text}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2.5 text-xs"
        onClick={onCopy}
      >
        {copied ? (
          <Check className="size-3.5" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
