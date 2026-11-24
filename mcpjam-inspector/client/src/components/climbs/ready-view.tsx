import { useState } from "react";
import type { ClimbForOption } from "@mcpjam/sdk/climbs";
import { Alert, AlertDescription, AlertTitle } from "@mcpjam/design-system/alert";
import { updateClimbMeasure } from "@/lib/apis/climbs-api";
import { BaselineCards } from "./baseline-cards";
import { ClimbForList } from "./climb-for-list";
import type { Climb } from "./climb-types";
import { SuiteCheck } from "./suite-check";

/**
 * The baseline, then what to climb for, then the suite check. Choosing an
 * option whose measure differs sets the climb's measure, which the backend
 * allows until round 1 has settled.
 */
export function ReadyView({
  climb,
  labels,
  suiteName,
  selected,
  onSelect,
  onNext,
  onChanged,
}: {
  climb: Climb;
  labels: Record<string, string>;
  suiteName: string;
  selected: string | undefined;
  onSelect: (id: string) => void;
  onNext: () => void;
  onChanged: () => void;
}) {
  const [failure, setFailure] = useState<string | null>(null);
  const choose = async (option: ClimbForOption) => {
    setFailure(null);
    if (option.measure !== climb.measure) {
      try {
        await updateClimbMeasure({ projectId: climb.projectId, climbId: climb.climbId, measure: option.measure });
        onChanged();
      } catch (error) {
        setFailure(error instanceof Error ? error.message : "The measure was not saved. Try again.");
        return;
      }
    }
    onSelect(option.id);
  };
  return (
    <div className="flex flex-col gap-6">
      <BaselineCards climb={climb} labels={labels} />
      {failure ? (
        <Alert variant="destructive">
          <AlertTitle>The choice was not saved</AlertTitle>
          <AlertDescription>
            <p>{failure}</p>
          </AlertDescription>
        </Alert>
      ) : null}
      <ClimbForList
        climb={climb}
        labels={labels}
        selected={selected}
        onSelect={(option) => void choose(option)}
        onNext={onNext}
      />
      <SuiteCheck check={climb.suiteCheck} suiteName={suiteName} serverName={climb.serverName} />
      {climb.notes?.length ? (
        <ul className="text-xs text-muted-foreground">
          {climb.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
