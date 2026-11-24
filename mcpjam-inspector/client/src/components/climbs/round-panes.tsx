import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { ToggleGroup, ToggleGroupItem } from "@mcpjam/design-system/toggle-group";
import type { Climb } from "./climb-types";
import { PaneCard } from "./pane-card";
import { useRoundPanes, type PaneMode } from "./use-round-panes";

/**
 * Transcripts side by side for one steering case: by version in one
 * environment, or this change in every environment. Only steering cases are
 * offered; validation and confirmation transcripts are never read.
 */
export function RoundPanes({
  climb,
  roundNumber,
  failedCaseKeys,
  labels,
  bestSub,
}: {
  climb: Climb;
  roundNumber: number;
  failedCaseKeys: string[];
  labels: Record<string, string>;
  bestSub: string;
}) {
  const steering = climb.groups.steeringCases.map((entry) => entry.key);
  const [chosenCase, setChosenCase] = useState<string>();
  const [chosenEnv, setChosenEnv] = useState<string>();
  const [mode, setMode] = useState<PaneMode>("version");
  const caseKey = chosenCase ?? failedCaseKeys.find((key) => steering.includes(key)) ?? steering[0];
  const environmentId = chosenEnv ?? climb.environmentIds[0];
  const { panes, caseTitles } = useRoundPanes({
    climbId: climb.climbId,
    climb,
    roundNumber,
    caseKey,
    environmentId,
    mode,
    labels,
    bestSub,
  });
  if (steering.length === 0) return null;
  const columns = Math.max(panes.length, 3);
  return (
    <section className="flex flex-col gap-3" aria-label="Transcripts">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Select value={caseKey} onValueChange={setChosenCase}>
          <SelectTrigger className="w-full max-w-md" aria-label="Case">
            <SelectValue placeholder="Choose a case" />
          </SelectTrigger>
          <SelectContent>
            {steering.map((key) => (
              <SelectItem key={key} value={key}>
                {caseTitles[key] ?? `Case ${key.slice(-6)}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex flex-wrap items-center gap-2">
          {mode === "version" && climb.environmentIds.length > 1 ? (
            <Select value={environmentId} onValueChange={setChosenEnv}>
              <SelectTrigger className="w-56" aria-label="Environment">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {climb.environmentIds.map((id) => (
                  <SelectItem key={id} value={id}>
                    {labels[id] ?? "Environment"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={mode}
            onValueChange={(value) => value && setMode(value as PaneMode)}
            aria-label="Compare transcripts"
          >
            <ToggleGroupItem value="version" className="px-3">
              By version
            </ToggleGroupItem>
            <ToggleGroupItem value="environment" className="px-3">
              By environment
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      <div
        className="grid grid-cols-1 gap-3 md:[grid-template-columns:repeat(var(--panes),minmax(0,1fr))]"
        style={{ "--panes": columns } as React.CSSProperties}
      >
        {panes.map((pane) => (
          <PaneCard key={`${pane.letter ?? ""}${pane.title}${pane.sub}`} pane={pane} />
        ))}
      </div>
    </section>
  );
}
