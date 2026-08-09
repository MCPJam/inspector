import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, Check, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { cn } from "@/lib/utils";
import { HOSTED_MODE } from "@/lib/config";
import type { FirstRunPhase } from "@/hooks/use-first-run-connect";

const DEMO_SERVER_LABEL = "Excalidraw";
const DEMO_SERVER_DESCRIPTION = "Demo server · draws diagrams from chat";

/**
 * Registry servers are stored as `"${displayName} (App)"` (see
 * `getRegistryServerName()`). That suffix is a storage-key convention, not
 * something to say to a person, so headings drop it.
 */
function toDisplayName(serverName: string): string {
  return serverName.replace(/\s*\(App\)$/, "");
}

const PLACEHOLDER = "https://mcp.example.com/mcp";

export interface FirstRunConnectProps {
  phase: FirstRunPhase;
  inputError: string | null;
  onConnectOwnServer: (rawInput: string) => void;
  onConnectDemoServer: () => void;
  onRetry: () => void;
  onAuthorize: () => void;
  onBackToChoosing: () => void;
  onClearInputError: () => void;
}

export function FirstRunConnect({
  phase,
  inputError,
  onConnectOwnServer,
  onConnectDemoServer,
  onRetry,
  onAuthorize,
  onBackToChoosing,
  onClearInputError,
}: FirstRunConnectProps) {
  return (
    <div
      className="flex min-h-screen w-full items-center justify-center bg-background px-6 py-12"
      data-testid="first-run-connect"
    >
      <div className="w-full max-w-md">
        {phase.kind === "choosing" ? (
          <ChooseServer
            inputError={inputError}
            onConnectOwnServer={onConnectOwnServer}
            onConnectDemoServer={onConnectDemoServer}
            onClearInputError={onClearInputError}
          />
        ) : phase.kind === "connecting" ? (
          <Connecting serverName={phase.serverName} />
        ) : (
          <ConnectFailed
            phase={phase}
            onRetry={onRetry}
            onAuthorize={onAuthorize}
            onBackToChoosing={onBackToChoosing}
            onConnectDemoServer={onConnectDemoServer}
          />
        )}
      </div>
    </div>
  );
}

function ChooseServer({
  inputError,
  onConnectOwnServer,
  onConnectDemoServer,
  onClearInputError,
}: {
  inputError: string | null;
  onConnectOwnServer: (rawInput: string) => void;
  onConnectDemoServer: () => void;
  onClearInputError: () => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onConnectOwnServer(value);
  };

  return (
    <div className="rounded-xl border border-border bg-card p-7 shadow-sm">
      <h1 className="text-xl font-semibold tracking-tight text-foreground">
        Point MCPJam at a server
      </h1>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
        MCPJam connects to your MCP server and lets you call its tools, inspect
        traces, and test how a model uses it.
      </p>

      <form onSubmit={handleSubmit} className="mt-6" noValidate>
        <label
          htmlFor="first-run-server-input"
          className="mb-2 block font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground"
        >
          {HOSTED_MODE ? "Server URL" : "Server URL or command"}
        </label>
        <Input
          id="first-run-server-input"
          ref={inputRef}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (inputError) onClearInputError();
          }}
          placeholder={PLACEHOLDER}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          aria-invalid={!!inputError}
          aria-describedby={
            inputError ? "first-run-server-error" : "first-run-server-help"
          }
          className="font-mono text-xs"
        />

        {inputError ? (
          <p
            id="first-run-server-error"
            role="alert"
            className="mt-2 text-xs text-destructive"
          >
            {inputError}
          </p>
        ) : (
          <p
            id="first-run-server-help"
            className="mt-2 text-xs text-muted-foreground"
          >
            {HOSTED_MODE
              ? "HTTP and SSE both work."
              : "HTTP, SSE, and stdio all work — npx -y @acme/mcp-server is fine too."}
          </p>
        )}

        <Button type="submit" className="mt-4 w-full">
          Connect
        </Button>
      </form>

      <div className="my-5 flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          or
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background p-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            {DEMO_SERVER_LABEL}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {DEMO_SERVER_DESCRIPTION}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onConnectDemoServer}
        >
          Try it
        </Button>
      </div>
    </div>
  );
}

/**
 * The milestones are the handshake the client already performs, in order, so a
 * stall shows the user (and us) exactly which step is hanging. They advance on
 * a timer rather than real transport events: the connect call is a single
 * awaited round trip today, so there is nothing finer-grained to subscribe to.
 * The labels stay honest because the order is real even when the timing is an
 * estimate — and the step never claims completion, it only claims to be underway.
 */
const CONNECT_STEPS = [
  "Reaching the server",
  "Negotiating capabilities",
  "Loading tools",
] as const;

const STEP_ADVANCE_MS = 900;

function Connecting({ serverName }: { serverName: string }) {
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (stepIndex >= CONNECT_STEPS.length - 1) return;
    const id = setTimeout(() => setStepIndex((i) => i + 1), STEP_ADVANCE_MS);
    return () => clearTimeout(id);
  }, [stepIndex]);

  return (
    <div
      className="rounded-xl border border-border bg-card p-7 shadow-sm"
      data-testid="first-run-connecting"
    >
      <h1 className="text-xl font-semibold tracking-tight text-foreground">
        Connecting to {toDisplayName(serverName)}
      </h1>

      <ul className="mt-6 flex flex-col gap-3" aria-live="polite">
        {CONNECT_STEPS.map((step, index) => {
          const isDone = index < stepIndex;
          const isCurrent = index === stepIndex;
          return (
            <li key={step} className="flex items-center gap-3 text-sm">
              <span
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-full",
                  isDone && "bg-success text-success-foreground",
                  isCurrent && "bg-primary text-primary-foreground",
                  !isDone && !isCurrent && "bg-muted"
                )}
                aria-hidden
              >
                {isDone ? (
                  <Check className="size-2.5" />
                ) : isCurrent ? (
                  <Loader2 className="size-2.5 animate-spin" />
                ) : null}
              </span>
              <span
                className={cn(
                  isDone || isCurrent
                    ? "text-foreground"
                    : "text-muted-foreground"
                )}
              >
                {step}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ConnectFailed({
  phase,
  onRetry,
  onAuthorize,
  onBackToChoosing,
  onConnectDemoServer,
}: {
  phase: Extract<FirstRunPhase, { kind: "error" }>;
  onRetry: () => void;
  onAuthorize: () => void;
  onBackToChoosing: () => void;
  onConnectDemoServer: () => void;
}) {
  const needsAuth = phase.reason === "reauth";

  return (
    <div
      className="rounded-xl border border-border bg-card p-7 shadow-sm"
      data-testid="first-run-error"
    >
      <h1 className="text-xl font-semibold tracking-tight text-foreground">
        {needsAuth
          ? `${toDisplayName(phase.serverName)} needs authorization`
          : `Couldn't reach ${toDisplayName(phase.serverName)}`}
      </h1>

      <div
        className={cn(
          "mt-5 rounded-lg border p-3",
          needsAuth
            ? "border-warning/40 bg-warning/10"
            : "border-destructive/30 bg-destructive/5"
        )}
        role="alert"
      >
        <div className="flex gap-2.5">
          <ShieldAlert
            className={cn(
              "mt-0.5 size-4 shrink-0",
              needsAuth ? "text-warning" : "text-destructive"
            )}
            aria-hidden
          />
          <div className="min-w-0">
            <p
              className={cn(
                "text-sm font-medium",
                needsAuth ? "text-foreground" : "text-destructive"
              )}
            >
              {needsAuth
                ? "This server requires OAuth before MCPJam can list its tools."
                : "MCPJam couldn't complete the connection."}
            </p>
            <p className="mt-1 break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
              {phase.message}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {needsAuth ? (
          <Button type="button" onClick={onAuthorize} className="flex-1">
            Authorize
          </Button>
        ) : (
          <Button type="button" onClick={onRetry} className="flex-1">
            Try again
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={onBackToChoosing}
          className="flex-1"
        >
          {phase.source === "demo" ? "Use another server" : "Edit server"}
        </Button>
      </div>

      {phase.source === "own" ? (
        <button
          type="button"
          onClick={onConnectDemoServer}
          className="mt-5 flex w-full items-center justify-center gap-1.5 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:underline focus-visible:outline-none"
        >
          Use the {DEMO_SERVER_LABEL} demo server instead
          <ArrowRight className="size-3" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
