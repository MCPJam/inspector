import { useState } from "react";
import { ChevronRight, Play } from "lucide-react";
import type { ChangeEntry } from "@mcpjam/sdk/climbs";
import { Button } from "@mcpjam/design-system/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { COPY } from "./climb-copy";
import { plural } from "./climb-format";
import type { Climb } from "./climb-types";
import { ChangeForm } from "./change-form";
import { entryLabel } from "./change-model";
import { entriesForOption } from "./ready-model";

export const CLIENT_NAMES: Record<string, string> = {
  mcpjam: "MCPJam",
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  "copilot-cli": "Copilot CLI",
  opencode: "OpenCode",
};

const SHOWN = 10;

function fact(entry: ChangeEntry): string {
  return entry.failedIterations > 0
    ? `${plural(entry.failedIterations, "failed iteration")} point here`
    : "No failed run points here";
}

function tried(entry: ChangeEntry): string {
  const last = entry.tried.at(-1);
  if (!last) return "Not tried";
  return `Round ${last.round}, ${last.verdict === "not_decided" ? "not decided" : last.verdict}`;
}

/**
 * What you can change, ranked: where the failed runs point first. Each row says
 * which clients read it, since a change no client reads cannot move a result.
 */
export function NewRound({
  climb,
  optionId,
  optionLabel,
  onSubmitted,
}: {
  climb: Climb;
  optionId: string | undefined;
  optionLabel: string;
  onSubmitted: (roundNumber: number) => void;
}) {
  const [open, setOpen] = useState<ChangeEntry | null>(null);
  const [all, setAll] = useState(false);
  const entries = entriesForOption(climb.whatCanChange ?? [], optionId);
  const shown = all ? entries : entries.slice(0, SHOWN);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">What you can change</h2>
        <p className="text-sm text-muted-foreground">{optionLabel}</p>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {climb.whatCanChange === undefined
            ? "The list appears once the baseline has settled and the server has been read."
            : "Nothing in this option can change. Go back and choose another one to climb for."}
        </p>
      ) : (
        <div>
          {shown.map((entry) => {
            const label = entryLabel(entry);
            const readers = entry.readBy
              .filter((reader) => reader.reads === "reads")
              .map((reader) => CLIENT_NAMES[reader.client] ?? reader.client);
            return (
              <Collapsible key={entry.where.mockPath} className="border-b border-border last:border-b-0">
                <div className="grid grid-cols-1 items-center gap-2 py-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto] md:gap-4">
                  <div className="min-w-0">
                    <div className="font-mono text-sm">
                      {label.name} <span className="font-sans text-muted-foreground">· {label.field}</span>
                    </div>
                    <div className="text-sm text-muted-foreground">{fact(entry)}</div>
                  </div>
                  <div className="text-sm text-muted-foreground">{tried(entry)}</div>
                  <div className="flex items-center gap-1">
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" size="sm" className="text-muted-foreground">
                        {COPY.readByLabel} <ChevronRight aria-hidden />
                      </Button>
                    </CollapsibleTrigger>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!entry.readByAnyClient || climb.state === "stopped"}
                      onClick={() => setOpen(entry)}
                    >
                      <Play aria-hidden /> Try it
                    </Button>
                  </div>
                </div>
                <CollapsibleContent className="pb-3 text-sm text-muted-foreground">
                  {entry.readByAnyClient
                    ? `Read by ${readers.join(", ") || "a client of this climb"}.`
                    : "No client of this climb reads this, so a round that changes only this is refused."}
                </CollapsibleContent>
              </Collapsible>
            );
          })}
          {entries.length > SHOWN && !all ? (
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setAll(true)}>
              Show all {entries.length}
            </Button>
          ) : null}
        </div>
      )}
      <ChangeForm
        climb={climb}
        entry={open}
        onClose={() => setOpen(null)}
        onSubmitted={(roundNumber) => {
          setOpen(null);
          onSubmitted(roundNumber);
        }}
      />
    </div>
  );
}
