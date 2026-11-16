import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, Copy, Download } from "lucide-react";
import type { NormalizedError } from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import { ErrorCard } from "@/components/ui/error-card";
import { copyToClipboard } from "@/lib/clipboard";
import { describeConnectFailure } from "@/lib/connect-failure";
import {
  checkHostedServerInput,
  DESKTOP_APP_DOWNLOAD_URL,
  type HostedInputCheck,
} from "@/lib/hosted-connect-precheck";

/**
 * Holds back a hosted submit the cloud backend cannot serve. A blocked input
 * stays blocked; a private address is shown once and then allowed, so the
 * second Connect on the same value goes through.
 */
export function useHostedInputGate(hosted: boolean) {
  const [shown, setShown] = useState<{
    check: HostedInputCheck;
    value: string;
  } | null>(null);
  const allow = useCallback(
    (value: string, transport: "http" | "stdio") => {
      if (!hosted) return true;
      const check = checkHostedServerInput(value, transport);
      const acknowledged =
        check.kind === "private_network" &&
        shown?.check.kind === "private_network" &&
        shown.value === value;
      if (check.kind === "ok" || acknowledged) {
        setShown(null);
        return true;
      }
      setShown({ check, value });
      return false;
    },
    [hosted, shown],
  );
  const clear = useCallback(() => setShown(null), []);
  return { check: shown?.check ?? null, allow, clear };
}

/**
 * A failed first connect, told as its catalog entry: what happened, why, and
 * the steps, open from the start. The raw error stays one click away under
 * "Technical details" and in Copy, for a bug report or an agent.
 */
export function ConnectionFailureNotice({
  error,
  normalized,
  action,
}: {
  error: string;
  normalized?: NormalizedError;
  action?: { label: string; onClick: () => void };
}) {
  const described = useMemo(
    () => describeConnectFailure(error, normalized),
    [error, normalized],
  );
  return (
    <ErrorCard
      error={described}
      action={action}
      density="card"
      defaultOpen
      rawInTechnical
      copyLabel="Copy error message"
      className="mt-3"
    />
  );
}

const HOSTED_INPUT_COPY = {
  stdio: {
    title: "The web app cannot run local commands",
    detail:
      "Copy your command and paste it into the MCPJam desktop app.",
  },
  localhost: {
    title: "The web app cannot reach localhost",
    detail:
      "To connect a local server, use the desktop app or run MCPJam on your computer with npx.",
  },
} as const;

/**
 * Why the hosted app will not submit what was pasted, with the two ways to
 * connect it anyway. A private address only warns: a tunnel or VPN can make
 * it reachable, so the next Connect goes through.
 */
export function HostedInputNotice({ check }: { check: HostedInputCheck }) {
  if (check.kind === "ok") return null;
  if (check.kind === "private_network") {
    return (
      <div
        role="alert"
        className="mt-3 flex items-start gap-2.5 rounded-md border border-warning/30 bg-warning/10 p-3"
      >
        <AlertCircle
          className="mt-0.5 size-4 shrink-0 text-warning"
          aria-hidden
        />
        <p className="text-[11.5px] leading-[1.5] text-card-foreground">
          This address is on a private network. Connect again to try anyway.
        </p>
      </div>
    );
  }
  const copy = HOSTED_INPUT_COPY[check.reason];
  return (
    <div
      role="alert"
      className="mt-3 rounded-md border border-warning/30 bg-warning/10 p-3"
    >
      <div className="flex items-start gap-2.5">
        <AlertCircle
          className="mt-0.5 size-4 shrink-0 text-warning"
          aria-hidden
        />
        <div className="min-w-0">
          <p className="text-[12px] font-semibold text-card-foreground">
            {copy.title}
          </p>
          <p className="mt-1 text-[11.5px] leading-[1.5] text-muted-foreground">
            {copy.detail}
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button asChild size="sm">
          <a
            href={DESKTOP_APP_DOWNLOAD_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Download className="size-3.5" aria-hidden />
            Download desktop app
          </a>
        </Button>
        <CopyCommandButton command={check.copyCommand} />
      </div>
    </div>
  );
}

function CopyCommandButton({ command }: { command: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );
  const copy = async () => {
    // `copyToClipboard` reports failure by returning false, not by throwing.
    const copied = await copyToClipboard(command);
    setState(copied ? "copied" : "failed");
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setState("idle"), 2000);
  };
  return (
    <Button type="button" size="sm" variant="outline" onClick={copy}>
      {state === "copied" ? (
        <Check className="size-3.5" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
      {state === "copied"
        ? "Copied"
        : state === "failed"
          ? "Copy failed. Try again"
          : "Copy npx command"}
    </Button>
  );
}
