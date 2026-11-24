import { useState } from "react";
import { CircleCheck, TriangleAlert } from "lucide-react";
import type { ListingCheck, VerificationReport } from "@mcpjam/sdk/climbs";
import { Alert, AlertDescription, AlertTitle } from "@mcpjam/design-system/alert";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Card } from "@mcpjam/design-system/card";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mcpjam/design-system/table";
import { verifyClimb } from "@/lib/apis/climbs-api";
import type { Climb } from "./climb-types";
import { gainText, verificationResult } from "./stopped-model";
import { UnitProgress } from "./unit-progress";

const STATUS_WORD = { applied: "Applied", missing: "Missing", different: "Different" } as const;

function Report({ report, check, labels }: { report: VerificationReport; check: ListingCheck | undefined; labels: Record<string, string> }) {
  return (
    <>
      {check ? (
        <section>
          <h3 className="mb-1 text-sm font-medium">Kept changes in your server's listing</h3>
          {check.changes.map((change) => (
            <div key={change.path} className="flex items-center gap-3 border-b border-border py-2 text-sm">
              <span className="flex-1">{change.summary}</span>
              <Badge variant="outline">{STATUS_WORD[change.status]}</Badge>
            </div>
          ))}
        </section>
      ) : null}
      <Card className="gap-0 overflow-hidden p-0 shadow-none">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Environment</TableHead>
              <TableHead>On the mock</TableHead>
              <TableHead>On your server</TableHead>
              <TableHead>Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.environments.map((env) => (
              <TableRow key={env.environmentId}>
                <TableCell className="font-medium">{labels[env.environmentId] ?? "Environment"}</TableCell>
                <TableCell className="text-muted-foreground">{gainText(env.gainOnMockBps)}</TableCell>
                <TableCell className="font-medium">{gainText(env.gainOnServerBps)}</TableCell>
                <TableCell>{verificationResult(env, report.holds)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <Alert variant={report.holds ? "success" : "warning"}>
        {report.holds ? <CircleCheck /> : <TriangleAlert />}
        <AlertTitle>{report.holds ? "The gain holds on your server." : "The gain was not shown on your server."}</AlertTitle>
        <AlertDescription>
          <p className="text-foreground/80">
            {report.commit.sha ? `Commit ${report.commit.sha}. ` : ""}
            {report.summary}
          </p>
        </AlertDescription>
      </Alert>
    </>
  );
}

/** What the verification stored of its listing check, when it has the shape this screen reads. */
function readListingCheck(value: unknown): ListingCheck | undefined {
  return typeof value === "object" && value !== null && Array.isArray((value as { changes?: unknown }).changes)
    ? (value as ListingCheck)
    : undefined;
}

/**
 * After the agent applies the prompt, run the same eval on the server: each kept
 * change is looked up in its listing first, and a change that is missing stops
 * the run until the person says to run anyway.
 */
export function VerifySection({
  climb,
  labels,
  onChanged,
}: {
  climb: Climb;
  labels: Record<string, string>;
  onChanged: () => void;
}) {
  const [commit, setCommit] = useState("");
  const [pending, setPending] = useState(false);
  const [blocked, setBlocked] = useState<{ message: string; check: ListingCheck } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const report = climb.verificationReports?.at(-1);
  const latest = climb.verifications.at(-1);
  const running = latest?.status === "running";

  const verify = async (runAnyway: boolean) => {
    setPending(true);
    setFailure(null);
    try {
      const result = await verifyClimb({
        projectId: climb.projectId,
        climbId: climb.climbId,
        ...(commit.trim() ? { commit: { sha: commit.trim() } } : {}),
        ...(runAnyway ? { runAnyway: true } : {}),
      });
      setBlocked(result.blockedBecause ? { message: result.blockedBecause, check: result.listingCheck } : null);
      onChanged();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The verification did not start. Try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Card className="gap-4 px-4 py-4 shadow-none" aria-label="Verify on your server">
      <h2 className="text-sm font-medium">Verify on your server</h2>
      {running && latest ? (
        <UnitProgress climbId={climb.climbId} unitKey={latest.unitKey} labels={labels} />
      ) : report ? (
        <Report report={report} check={readListingCheck(latest?.listingCheck)} labels={labels} />
      ) : null}
      {blocked ? (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertTitle>Not run</AlertTitle>
          <AlertDescription>
            <p className="text-foreground/80">{blocked.message}</p>
            {blocked.check.changes.map((change) => (
              <p key={change.path} className="mt-1 text-foreground/80">
                {STATUS_WORD[change.status]}: {change.summary}
              </p>
            ))}
            <Button size="sm" variant="outline" className="mt-3" disabled={pending} onClick={() => void verify(true)}>
              Run anyway
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {running ? null : (
        <>
          <p className="text-sm text-muted-foreground">
            {report
              ? "Verify again after another commit. A climb allows three verifications."
              : "After your agent applies the prompt, run the same eval on your server."}
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="verify-commit">Commit</Label>
              <Input
                id="verify-commit"
                placeholder="4f2c9ab"
                className="w-52 font-mono"
                value={commit}
                onChange={(event) => setCommit(event.target.value)}
              />
            </div>
            <Button onClick={() => void verify(false)} disabled={pending}>
              Verify
            </Button>
          </div>
        </>
      )}
      {failure ? <p className="text-sm text-destructive">{failure}</p> : null}
    </Card>
  );
}
