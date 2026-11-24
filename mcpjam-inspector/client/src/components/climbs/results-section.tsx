import type { ClimbSummary } from "@mcpjam/sdk/climbs";
import { Card } from "@mcpjam/design-system/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mcpjam/design-system/table";
import { measureTitle, ratioChange } from "./climb-format";
import { rateText } from "./stopped-model";

const range = (from: number | null, to: number | null) =>
  from === null || to === null ? "None" : `${rateText(from)} → ${rateText(to)}`;

/** Steering and validation results, labeled as the cases that helped pick the result. */
export function ResultsSection({ summary, labels }: { summary: ClimbSummary; labels: Record<string, string> }) {
  const measured = summary.measure !== "pass_rate";
  const validation = new Map(summary.validation.environments.map((env) => [env.environmentId, env]));
  return (
    <section className="flex flex-col gap-2" aria-label="Results">
      <Card className="gap-0 overflow-hidden p-0 shadow-none">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Environment</TableHead>
              {measured ? <TableHead>{measureTitle(summary.measure)}</TableHead> : null}
              <TableHead>Steering</TableHead>
              <TableHead>Validation</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.steering.environments.map((env) => {
              const held = validation.get(env.environmentId);
              return (
                <TableRow key={env.environmentId}>
                  <TableCell className="font-medium">{labels[env.environmentId] ?? "Environment"}</TableCell>
                  {measured ? (
                    <TableCell className="tabular-nums">
                      {env.measureRatioBps === undefined ? "No change" : ratioChange(env.measureRatioBps)}
                    </TableCell>
                  ) : null}
                  <TableCell className="tabular-nums">{range(env.baselinePassRateBps, env.bestPassRateBps)}</TableCell>
                  <TableCell className="tabular-nums">
                    {held ? range(held.baselinePassRateBps, held.bestPassRateBps) : "None"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
      <p className="text-xs text-muted-foreground">Both groups helped pick this result.</p>
    </section>
  );
}
