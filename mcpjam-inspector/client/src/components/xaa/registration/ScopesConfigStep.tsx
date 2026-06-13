import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  checkResourceHealth,
  type HealthCheckResult,
} from "@/lib/xaa/discovery-client";
import type { RegistrationDraft } from "./wizard-draft";

interface ScopesConfigStepProps {
  draft: RegistrationDraft;
  onChange: (updates: Partial<RegistrationDraft>) => void;
}

type CheckState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; result: HealthCheckResult }
  | { status: "error"; message: string };

function describeResult(result: HealthCheckResult): string {
  if (result.ok) {
    return `Reachable — HTTP ${result.status} in ${result.durationMs}ms`;
  }
  if (result.reason === "timeout") {
    return "Timed out — the server didn't respond.";
  }
  if (result.reason === "redirect_not_followed") {
    return `Responded with a redirect (HTTP ${result.status}); redirects aren't followed.`;
  }
  if (typeof result.status === "number") {
    return `Reachable but unhealthy — HTTP ${result.status} ${result.statusText ?? ""}`.trim();
  }
  return "Unreachable.";
}

export function ScopesConfigStep({ draft, onChange }: ScopesConfigStepProps) {
  const [check, setCheck] = useState<CheckState>({ status: "idle" });

  const healthUrl = draft.healthCheckUrl.trim();

  const handleCheck = async () => {
    if (!healthUrl) return;
    setCheck({ status: "loading" });
    try {
      const result = await checkResourceHealth(healthUrl);
      setCheck({ status: "done", result });
    } catch (error) {
      setCheck({
        status: "error",
        message: error instanceof Error ? error.message : "Health check failed",
      });
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="xaa-reg-scopes">Scopes</Label>
        <Input
          id="xaa-reg-scopes"
          value={draft.scopes}
          onChange={(event) => onChange({ scopes: event.target.value })}
          placeholder="read write (space-separated, optional)"
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          Requested on the access token during a run.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="xaa-reg-health-url">Health check URL</Label>
        <div className="flex items-stretch gap-2">
          <Input
            id="xaa-reg-health-url"
            value={draft.healthCheckUrl}
            onChange={(event) =>
              onChange({ healthCheckUrl: event.target.value })
            }
            placeholder="https://your-server.example.com/health (optional)"
            autoComplete="off"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 self-stretch"
            onClick={handleCheck}
            disabled={!healthUrl || check.status === "loading"}
          >
            {check.status === "loading" ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                Checking
              </>
            ) : (
              "Check"
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Used to verify the resource is reachable before a run.
        </p>
      </div>

      {check.status === "done" && (
        <div
          data-testid="xaa-reg-health-result"
          className={
            check.result.ok
              ? "flex items-start gap-1.5 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700 dark:border-green-900 dark:bg-green-950/20 dark:text-green-300"
              : "flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300"
          }
        >
          {check.result.ok ? (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          {describeResult(check.result)}
        </div>
      )}
      {check.status === "error" && (
        <div
          data-testid="xaa-reg-health-error"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/20 dark:text-red-300"
        >
          {check.message}
        </div>
      )}
    </div>
  );
}
