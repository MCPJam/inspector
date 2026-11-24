import { Play } from "lucide-react";
import type { PlatformClimbListItem } from "@mcpjam/sdk/platform";
import { Button } from "@mcpjam/design-system/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mcpjam/design-system/table";
import { listClimbs } from "@/lib/apis/climbs-api";
import { measureTitle, shortDate } from "./climb-format";
import { useAsyncRead } from "./use-async-read";

const STATE_WORD: Record<PlatformClimbListItem["state"], string> = {
  baselining: "Baseline running",
  ready: "Ready",
  running: "Running",
  stopped: "Stopped",
};

const LIST_POLL_MS = 15_000;

/** The climbs of one suite. A climb an agent started shows up here as it begins. */
export function ClimbList({
  projectId,
  suiteId,
  onOpen,
  onStart,
}: {
  projectId: string;
  suiteId: string;
  onOpen: (climbId: string) => void;
  onStart: () => void;
}) {
  const read = useAsyncRead((signal) => listClimbs({ projectId, suiteId }, signal), `${projectId}:${suiteId}`, {
    pollMs: () => LIST_POLL_MS,
  });
  const climbs = read.data;
  return (
    <div className="flex flex-col gap-4" data-testid="climb-list">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Climbs of this suite</p>
        <Button size="sm" onClick={onStart}>
          <Play aria-hidden /> Start a climb
        </Button>
      </div>
      {climbs === undefined ? (
        read.error ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-destructive">
              {read.error instanceof Error ? read.error.message : "The climbs did not load."}
            </p>
            <Button size="sm" variant="outline" onClick={read.reload}>
              Try again
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" role="status">
            Loading climbs.
          </p>
        )
      ) : climbs.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No climbs yet. Start one to improve a server from this suite's cases.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Climb for</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Rounds</TableHead>
              <TableHead>Server</TableHead>
              <TableHead>Started</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {climbs.map((climb) => (
              <TableRow key={climb.climbId}>
                <TableCell className="font-medium">
                  <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => onOpen(climb.climbId)}>
                    {measureTitle(climb.measure)}
                  </button>
                </TableCell>
                <TableCell>{STATE_WORD[climb.state]}</TableCell>
                <TableCell className="tabular-nums">
                  {climb.roundsStarted} of {climb.roundLimit}
                </TableCell>
                <TableCell>{climb.serverName}</TableCell>
                <TableCell className="text-muted-foreground">{shortDate(climb.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
