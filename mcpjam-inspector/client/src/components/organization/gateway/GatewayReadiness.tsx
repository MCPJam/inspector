import { CheckCircle2, CircleSlash } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { cn } from "@mcpjam/design-system/cn";
import { Label } from "@mcpjam/design-system/label";
import {
  GATEWAY_APIS,
  GATEWAY_API_LABELS,
  type GatewayApi,
  type GatewayApiTestResult,
} from "@/shared/gateway-connection";
import { STATUS_TONE_CLASSES } from "../org-ai-config-presentation";
import { gatewayApiUsedBy, type WorksWithRow } from "./gateway-works-with";

const RESULT_BADGES: Record<
  GatewayApiTestResult,
  { label: string; tone: keyof typeof STATUS_TONE_CLASSES }
> = {
  ok: { label: "Answered", tone: "success" },
  failed: { label: "Failed", tone: "destructive" },
  untested: { label: "Not tested", tone: "muted" },
};

/** The APIs the gateway serves, each with its last Test result and its users. */
export function GatewayApiList({
  selected,
  results,
  onChange,
}: {
  selected: readonly GatewayApi[];
  results: Partial<Record<GatewayApi, GatewayApiTestResult>>;
  onChange: (apis: GatewayApi[]) => void;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="pb-1 text-sm font-medium">APIs</legend>
      {GATEWAY_APIS.map((api) => {
        const result = results[api];
        const badge = result ? RESULT_BADGES[result] : undefined;
        return (
          <div key={api} className="flex items-start gap-2">
            <Checkbox
              id={`gateway-api-${api}`}
              className="mt-0.5"
              checked={selected.includes(api)}
              onCheckedChange={(checked) =>
                onChange(
                  GATEWAY_APIS.filter((each) =>
                    each === api ? checked === true : selected.includes(each),
                  ),
                )
              }
            />
            <div className="min-w-0 flex-1 space-y-0.5">
              <Label htmlFor={`gateway-api-${api}`} className="gap-2">
                {GATEWAY_API_LABELS[api]}
                {badge ? (
                  <Badge
                    variant="outline"
                    className={STATUS_TONE_CLASSES[badge.tone]}
                  >
                    {badge.label}
                  </Badge>
                ) : null}
              </Label>
              <p className="text-xs text-muted-foreground">
                {gatewayApiUsedBy(api)}
              </p>
            </div>
          </div>
        );
      })}
    </fieldset>
  );
}

/** Readiness per feature and harness client, before the admin saves. */
export function GatewayWorksWithList({ rows }: { rows: WorksWithRow[] }) {
  return (
    <section aria-labelledby="gateway-works-with" className="space-y-2">
      <h3 id="gateway-works-with" className="text-sm font-medium">
        Works with
      </h3>
      <ul className="divide-y divide-border/60 rounded-md border border-border/60">
        {rows.map((row) => (
          <li key={row.id} className="flex items-start gap-2 px-3 py-2 text-sm">
            {row.ready ? (
              <CheckCircle2
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-success"
              />
            ) : (
              <CircleSlash
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
            )}
            <div className="min-w-0 flex-1">
              <p className="font-medium">{row.label}</p>
              {row.reason ? (
                <p className="text-xs text-muted-foreground">{row.reason}</p>
              ) : null}
            </div>
            <Badge
              variant="outline"
              className={cn(
                "shrink-0",
                STATUS_TONE_CLASSES[row.ready ? "success" : "muted"],
              )}
            >
              {row.ready ? "Ready" : "Unavailable"}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}
