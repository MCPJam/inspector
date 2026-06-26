import { useCallback, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Loader2,
  MinusCircle,
  ShieldCheck,
} from "lucide-react";
import { Link } from "react-router";
import { canRunConformance } from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import type { ServerWithName } from "@/state/app-types";
import { routePaths } from "@/lib/app-navigation";
import {
  runProtocolConformance,
  runAppsConformance,
} from "@/lib/apis/mcp-conformance-api";

/**
 * Tier-0 "spec floor" gate above the host-compat matrix. A conformance failure
 * breaks on EVERY host, so it's separated out and shown first — fix it before
 * reading the per-host gaps below.
 *
 * On-demand (not auto-run): conformance hits the live server and can be slow,
 * so the developer clicks to run. Transport nuance comes straight from the
 * SDK's `canRunConformance` — protocol/oauth are HTTP-only, so over stdio the
 * protocol suite reads "not runnable here", never "failed".
 */

type SuiteId = "protocol" | "apps";

const SUITE_LABEL: Record<SuiteId, string> = {
  protocol: "Protocol",
  apps: "Apps",
};

type SuiteOutcome =
  | { status: "idle" }
  | { status: "unsupported"; reason: string }
  | { status: "running" }
  | { status: "error"; error: string }
  | { status: "done"; passed: boolean; failedTitles: string[]; total: number };

const failedTitlesOf = (
  checks: ReadonlyArray<{ status: string; title: string }>,
): string[] =>
  checks.filter((c) => c.status === "failed").map((c) => c.title);

export function ConformanceGate({ server }: { server: ServerWithName }) {
  const isConnected = server.connectionStatus === "connected";

  // `canRunConformance` is the single source of truth for transport gating.
  const support = useMemo(() => {
    const config = server.config as Parameters<typeof canRunConformance>[1];
    return {
      protocol: canRunConformance("protocol", config),
      apps: canRunConformance("apps", config),
    };
  }, [server.config]);

  const [outcomes, setOutcomes] = useState<Record<SuiteId, SuiteOutcome>>({
    protocol: { status: "idle" },
    apps: { status: "idle" },
  });
  const [hasRun, setHasRun] = useState(false);

  const isRunning =
    outcomes.protocol.status === "running" || outcomes.apps.status === "running";

  const runChecks = useCallback(async () => {
    setHasRun(true);
    const serverName = server.name;

    const runSuite = async (
      suite: SuiteId,
      run: () => Promise<{
        result: { passed: boolean; checks: ReadonlyArray<{ status: string; title: string }> };
      }>,
    ) => {
      if (!support[suite].supported) {
        setOutcomes((prev) => ({
          ...prev,
          [suite]: {
            status: "unsupported",
            reason: support[suite].reason ?? "Not runnable for this server.",
          },
        }));
        return;
      }
      setOutcomes((prev) => ({ ...prev, [suite]: { status: "running" } }));
      try {
        const { result } = await run();
        setOutcomes((prev) => ({
          ...prev,
          [suite]: {
            status: "done",
            passed: result.passed,
            failedTitles: failedTitlesOf(result.checks),
            total: result.checks.length,
          },
        }));
      } catch (err) {
        setOutcomes((prev) => ({
          ...prev,
          [suite]: {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          },
        }));
      }
    };

    await Promise.all([
      runSuite("protocol", () => runProtocolConformance(serverName)),
      runSuite("apps", () => runAppsConformance(serverName)),
    ]);
  }, [server.name, support]);

  // Aggregate banner: any real failure ⇒ "fix first"; all-ran-and-passed ⇒ ok.
  const anyFailed = (["protocol", "apps"] as const).some((s) => {
    const o = outcomes[s];
    return o.status === "done" && !o.passed;
  });
  const allClean =
    hasRun &&
    !isRunning &&
    (["protocol", "apps"] as const).every((s) => {
      const o = outcomes[s];
      return (
        o.status === "unsupported" || (o.status === "done" && o.passed)
      );
    });

  return (
    <div className="mb-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-foreground">
            Spec conformance
          </div>
          <div className="text-[11px] text-muted-foreground">
            The floor — a spec failure breaks on every host.
          </div>
        </div>
        <Link
          to={routePaths.conformance}
          className="flex flex-shrink-0 items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground"
        >
          Details
          <ChevronRight className="h-3 w-3" />
        </Link>
        <Button
          size="sm"
          variant="outline"
          className="h-7 flex-shrink-0 gap-1 px-2 text-xs"
          disabled={!isConnected || isRunning}
          onClick={runChecks}
        >
          {isRunning ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin" />
              Checking…
            </>
          ) : hasRun ? (
            "Re-run"
          ) : (
            "Run checks"
          )}
        </Button>
      </div>

      {!isConnected && (
        <div className="mt-2 text-[11px] text-muted-foreground">
          Connect the server to run spec checks.
        </div>
      )}

      {hasRun && (
        <div className="mt-2.5 space-y-1.5">
          {(["protocol", "apps"] as const).map((suite) => (
            <SuiteRow key={suite} suite={suite} outcome={outcomes[suite]} />
          ))}
        </div>
      )}

      {anyFailed && (
        <div className="mt-2.5 flex items-start gap-1.5 rounded border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-[11px] text-red-600 dark:text-red-400">
          <AlertCircle className="mt-0.5 h-3 w-3 flex-shrink-0" />
          <span>
            Fix these spec failures first — they break on every host, not just
            the ones flagged below.
          </span>
        </div>
      )}
      {allClean && !anyFailed && (
        <div className="mt-2.5 flex items-start gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="mt-0.5 h-3 w-3 flex-shrink-0" />
          <span>
            Passes spec checks — the gaps below are host-specific, not spec
            problems.
          </span>
        </div>
      )}
    </div>
  );
}

function SuiteRow({
  suite,
  outcome,
}: {
  suite: SuiteId;
  outcome: SuiteOutcome;
}) {
  const label = SUITE_LABEL[suite];
  if (outcome.status === "running") {
    return (
      <Row label={label}>
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        <span className="text-muted-foreground">Checking…</span>
      </Row>
    );
  }
  if (outcome.status === "unsupported") {
    return (
      <Row label={label}>
        <MinusCircle className="h-3 w-3 text-muted-foreground" />
        <span className="text-muted-foreground">
          Not runnable here — {outcome.reason}
        </span>
      </Row>
    );
  }
  if (outcome.status === "error") {
    return (
      <Row label={label}>
        <AlertCircle className="h-3 w-3 text-red-500" />
        <span className="text-red-600 dark:text-red-400">{outcome.error}</span>
      </Row>
    );
  }
  if (outcome.status === "done") {
    const failedCount = outcome.failedTitles.length;
    if (outcome.passed || failedCount === 0) {
      return (
        <Row label={label}>
          <CheckCircle2 className="h-3 w-3 text-emerald-500" />
          <span className="text-muted-foreground">
            {outcome.total} check{outcome.total === 1 ? "" : "s"} passed
          </span>
        </Row>
      );
    }
    return (
      <Row label={label}>
        <AlertCircle className="h-3 w-3 text-red-500" />
        <span className="text-red-600 dark:text-red-400">
          {failedCount} failed: {outcome.failedTitles.slice(0, 3).join(", ")}
          {failedCount > 3 ? ` +${failedCount - 3}` : ""}
        </span>
      </Row>
    );
  }
  return null;
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <span className="w-14 flex-shrink-0 font-medium text-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}
