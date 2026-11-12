/**
 * The first-run screens that need no authentication state: Connect, Connected,
 * and the sample-server failure. The overlay passes values and callbacks in.
 */
import type { FormEvent } from "react";
import { ArrowRight, Link2, PenLine } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import type { GuestSessionRefusalReason } from "@/lib/guest-session";
import { HOSTED_MODE } from "@/lib/config";
import { FirstRunHeading, FirstRunSkipRow, ServerTile } from "./FirstRunFrame";
import {
  ConnectionFailureNotice,
  GuestSessionRefusalNotice,
} from "./FirstRunNotices";

export interface FirstRunToolPreview {
  name: string;
  description?: string;
}

export function FirstRunConnectScreen({
  serverUrlOrCommand,
  serverUrlError,
  onServerUrlOrCommandChange,
  onSubmit,
  onConnectDemo,
  onSkip,
  guestSessionRefusal,
  onSignIn,
}: {
  serverUrlOrCommand: string;
  serverUrlError: string | null;
  onServerUrlOrCommandChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onConnectDemo: () => void;
  onSkip: () => void;
  guestSessionRefusal: GuestSessionRefusalReason | null;
  onSignIn?: () => void;
}) {
  const disabled = guestSessionRefusal !== null;
  return (
    <>
      <FirstRunHeading
        title="Connect an MCP server"
        description={
          HOSTED_MODE
            ? "Paste a server URL. MCPJam checks the connection, loads your tools, and opens the Playground."
            : "Paste a server URL or a local command. MCPJam checks the connection, loads your tools, and opens the Playground."
        }
      />

      {guestSessionRefusal ? (
        <GuestSessionRefusalNotice
          reason={guestSessionRefusal}
          onSignIn={onSignIn}
        />
      ) : null}

      <form className="mt-9" onSubmit={onSubmit}>
        <Label htmlFor="first-run-server-url" className="text-sm">
          {HOSTED_MODE ? "Server URL" : "Server URL or command"}
        </Label>
        <div className="mt-2 flex flex-wrap gap-2">
          <div className="relative flex min-w-0 flex-[1_1_20rem] items-center">
            <Link2
              className="pointer-events-none absolute left-4 size-4.5 text-muted-foreground"
              aria-hidden
            />
            <Input
              id="first-run-server-url"
              className="h-13 bg-card pl-11 font-mono md:text-base"
              placeholder="https://mcp.example.com/mcp"
              spellCheck={false}
              autoComplete="off"
              value={serverUrlOrCommand}
              aria-invalid={serverUrlError ? true : undefined}
              aria-describedby="first-run-server-url-hint"
              onChange={(event) =>
                onServerUrlOrCommandChange(event.target.value)
              }
            />
          </div>
          <Button
            type="submit"
            size="lg"
            disabled={disabled}
            className="h-13 font-semibold"
          >
            Connect
          </Button>
        </div>
        {serverUrlError ? (
          <p
            id="first-run-server-url-hint"
            className="mt-2.5 text-sm text-destructive"
            role="alert"
          >
            {serverUrlError}
          </p>
        ) : (
          <p
            id="first-run-server-url-hint"
            className="mt-2.5 text-sm text-muted-foreground"
          >
            {HOSTED_MODE
              ? "Works with Streamable HTTP and SSE servers."
              : "Works with Streamable HTTP, SSE, and local stdio commands."}
          </p>
        )}
      </form>

      <section className="mt-14" aria-labelledby="first-run-sample-heading">
        <h2
          id="first-run-sample-heading"
          className="text-sm font-medium text-foreground"
        >
          Or start with a sample server
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-4 rounded-lg border border-border bg-card p-4">
          <div
            aria-hidden
            className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-foreground"
          >
            <PenLine className="size-5" />
          </div>
          <div className="min-w-0 flex-[1_1_16rem]">
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold">Excalidraw</span>
              <Badge variant="outline">MCP App</Badge>
            </div>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              Draws diagrams from chat. A quick way to see how an MCP App
              renders in each client.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="lg"
            disabled={disabled}
            aria-label="Try the Excalidraw sample server"
            onClick={onConnectDemo}
          >
            Try it
          </Button>
        </div>
      </section>

      <FirstRunSkipRow onSkip={onSkip} />
    </>
  );
}

const TOOL_PREVIEW_LIMIT = 4;

export function FirstRunConnectedScreen({
  serverName,
  toolCount,
  toolPreview,
  animate,
  isOpeningPlayground,
  onOpenPlayground,
}: {
  serverName: string;
  toolCount: number | null;
  toolPreview?: readonly FirstRunToolPreview[];
  animate: boolean;
  isOpeningPlayground: boolean;
  onOpenPlayground: () => void;
}) {
  const shownTools = (toolPreview ?? []).slice(0, TOOL_PREVIEW_LIMIT);
  const remainingTools =
    toolCount === null ? 0 : Math.max(toolCount - shownTools.length, 0);
  return (
    <>
      <FirstRunHeading
        tile={<ServerTile name={serverName} connected animate={animate} />}
        title={`${serverName} is connected`}
        description={
          toolCount === null
            ? "Tools can finish loading in the Playground."
            : `${toolCount} ${toolCount === 1 ? "tool" : "tools"} ready to use`
        }
      />

      {shownTools.length > 0 ? (
        <div className="mt-9 rounded-lg border border-border bg-card">
          <h2 className="border-b border-border px-5 py-3 text-sm font-medium">
            Tools
          </h2>
          <ul className="divide-y divide-border px-5">
            {shownTools.map((tool) => (
              <li
                key={tool.name}
                className="flex flex-wrap gap-x-4 gap-y-1 py-3 text-sm"
              >
                <span className="w-44 shrink-0 truncate font-mono text-foreground">
                  {tool.name}
                </span>
                <span className="min-w-0 flex-[1_1_14rem] truncate text-muted-foreground">
                  {tool.description}
                </span>
              </li>
            ))}
            {remainingTools > 0 ? (
              <li className="py-3 text-sm text-muted-foreground">
                and {remainingTools} more
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      <div className="mt-7 flex flex-wrap items-center gap-4">
        <Button
          type="button"
          size="lg"
          className="h-12 font-semibold"
          onClick={onOpenPlayground}
          disabled={isOpeningPlayground}
        >
          {isOpeningPlayground ? "Opening Playground…" : "Open Playground"}
          {isOpeningPlayground ? null : <ArrowRight aria-hidden />}
        </Button>
        <p className="text-sm text-muted-foreground">
          Try these tools in ChatGPT, Claude, and other clients.
        </p>
      </div>
    </>
  );
}

export function FirstRunDemoFailedScreen({
  error,
  onRetry,
  onConnectOwnServer,
  onSkip,
}: {
  error: string;
  onRetry: () => void;
  onConnectOwnServer: () => void;
  onSkip: () => void;
}) {
  return (
    <>
      <FirstRunHeading
        title="Sample server unavailable"
        description="MCPJam couldn't reach the Excalidraw sample server. Try again, or connect your own server."
      />
      <ConnectionFailureNotice
        title="The sample server didn't respond"
        error={error}
      />
      <div className="mt-8 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="lg"
          className="h-12 font-semibold"
          onClick={onRetry}
        >
          Try again
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="lg"
          className="h-12"
          onClick={onConnectOwnServer}
        >
          Connect my own server
        </Button>
      </div>
      <FirstRunSkipRow onSkip={onSkip} />
    </>
  );
}
