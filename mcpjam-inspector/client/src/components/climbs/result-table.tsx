import type { PlatformClimbMeasure } from "@mcpjam/sdk/platform";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mcpjam/design-system/table";
import { measureTitle, percent, ratioChange, ruleSentence } from "./climb-format";
import type { RoundEnvironment } from "./round-verdict";

const range = (rate: { bestBps: number; candidateBps: number } | undefined) =>
  rate ? `${percent(rate.bestBps)} → ${percent(rate.candidateBps)}` : "None";

/** Each environment's numbers, the noise they were judged against, and the rule in words. */
export function ResultTable({
  environments,
  labels,
  measure,
  minImprovementBps,
}: {
  environments: RoundEnvironment[];
  labels: Record<string, string>;
  measure: PlatformClimbMeasure;
  minImprovementBps: number;
}) {
  const measured = measure !== "pass_rate";
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Environment</TableHead>
            {measured ? <TableHead>{measureTitle(measure)}</TableHead> : null}
            <TableHead>Pass rate</TableHead>
            <TableHead>Validation</TableHead>
            <TableHead>Noise</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {environments.map((env) => (
            <TableRow key={env.environmentId}>
              <TableCell className="font-medium">{labels[env.environmentId] ?? "Environment"}</TableCell>
              {measured ? (
                <TableCell className="tabular-nums">
                  {env.steering?.measure ? ratioChange(env.steering.measure.ratioBps) : "None"}
                </TableCell>
              ) : null}
              <TableCell className="tabular-nums">{range(env.steering?.passRate)}</TableCell>
              <TableCell className="tabular-nums">{range(env.validation?.passRate)}</TableCell>
              <TableCell className="text-muted-foreground">
                {env.steering?.passRate ? `±${percent(env.steering.passRate.noiseBps)}` : "None"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="mt-3 text-xs text-muted-foreground">
        {ruleSentence(measure, minImprovementBps)} Moves inside the noise don't count.
      </p>
    </>
  );
}
