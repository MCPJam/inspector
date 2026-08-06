import { Button } from "@mcpjam/design-system/button";
import { Loader2 } from "lucide-react";
import {
  describeConformanceScore,
  type ConformanceScore,
} from "@mcpjam/sdk/browser";
import type {
  AppsSuiteState,
  OAuthSuiteState,
  ProtocolSuiteState,
  SuiteState,
  TasksSuiteState,
} from "@/hooks/use-conformance-run";

const SUITE_TITLES = {
  protocol: "Protocol",
  apps: "Apps",
  tasks: "Tasks",
  oauth: "OAuth",
} as const;

function SuiteRow({
  title,
  state,
  score,
  action,
}: {
  title: string;
  state: SuiteState;
  score?: ConformanceScore;
  action?: React.ReactNode;
}) {
  const detail = (() => {
    if (state.status === "running") return "Running…";
    if (state.status === "needs-authorization") {
      return "Not run — authorize to include it";
    }
    if (state.status === "unavailable") {
      // A suite with nothing to judge is not a failure, and must never read
      // as one. "Not scored" and "scored zero" are opposite claims.
      return state.unavailableReason ?? "Not applicable — not scored";
    }
    if (state.status === "error") return state.error ?? "Could not run";
    if (score) return describeConformanceScore(score);
    return "Not run";
  })();

  const tone =
    state.status === "error" || state.verdict === "failed"
      ? "text-red-400"
      : state.verdict === "incomplete"
      ? "text-amber-500"
      : state.verdict === "passed"
      ? "text-green-500"
      : "text-muted-foreground";

  return (
    <div className="flex items-start justify-between gap-3 border-b border-border/40 px-4 py-3 last:border-b-0">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2 text-sm font-medium">
          {title}
          {state.status === "running" && (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className={`text-[11px] ${tone}`}>{detail}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {score && score.score !== null && (
          <span className="text-sm font-semibold tabular-nums">
            {score.score}
            <span className="text-[10px] font-normal text-muted-foreground">
              /100
            </span>
          </span>
        )}
        {action}
      </div>
    </div>
  );
}

/**
 * Per-suite breakdown under the headline number.
 *
 * The OAuth row carries the one interactive affordance on this page: a run
 * that reached the authorization step waits here instead of opening a popup
 * nobody asked for. Declining costs nothing — the suite reports "not scored",
 * which is a different statement from a zero and is rendered as one.
 */
export function ScoreSuiteBreakdown({
  protocol,
  apps,
  tasks,
  oauth,
  protocolScore,
  appsScore,
  tasksScore,
  oauthScore,
  onAuthorizeOAuth,
}: {
  protocol: ProtocolSuiteState;
  apps: AppsSuiteState;
  tasks: TasksSuiteState;
  oauth: OAuthSuiteState;
  protocolScore?: ConformanceScore;
  appsScore?: ConformanceScore;
  tasksScore?: ConformanceScore;
  oauthScore?: ConformanceScore;
  onAuthorizeOAuth?: () => void;
}) {
  return (
    <div className="rounded-md border border-border/50">
      <SuiteRow
        title={SUITE_TITLES.protocol}
        state={protocol}
        score={protocolScore}
      />
      <SuiteRow title={SUITE_TITLES.apps} state={apps} score={appsScore} />
      <SuiteRow title={SUITE_TITLES.tasks} state={tasks} score={tasksScore} />
      <SuiteRow
        title={SUITE_TITLES.oauth}
        state={oauth}
        score={oauthScore}
        action={
          oauth.status === "needs-authorization" && onAuthorizeOAuth ? (
            <Button size="sm" variant="outline" onClick={onAuthorizeOAuth}>
              Authorize to include OAuth
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
