import { Card } from "@mcpjam/design-system/card";
import type { Climb } from "./climb-types";
import { percent, plural } from "./climb-format";

type Group = NonNullable<NonNullable<Climb["baseline"]>["environments"][number]["steering"]>;

const runs = (group: Group | undefined) =>
  group ? group.passRateBps.map((bps) => percent(bps)).join(", ") : "None";

/** The baseline per environment: both runs' pass rates and the noise between them. */
export function BaselineCards({ climb, labels }: { climb: Climb; labels: Record<string, string> }) {
  const environments = climb.baseline?.environments ?? [];
  const newCases = climb.groups.newCases ?? [];
  return (
    <section className="flex flex-col gap-2" aria-label="Baseline">
      <h2 className="text-sm font-medium">Baseline</h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {environments.map((env) => (
          <Card key={env.environmentId} className="gap-1.5 px-4 py-3 shadow-none" data-testid="baseline-card">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{labels[env.environmentId] ?? "Environment"}</span>
              {env.steering ? (
                <span className="text-xs text-muted-foreground">Noise ±{percent(env.steering.passRateNoiseBps)}</span>
              ) : null}
            </div>
            <div className="text-sm tabular-nums">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Pass rate</span>
                <span>{runs(env.steering)}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Validation</span>
                <span>{runs(env.validation)}</span>
              </div>
            </div>
            {env.noRoomToImprove ? (
              <p className="text-xs text-muted-foreground">Every case passes here, so pass rate cannot improve.</p>
            ) : null}
          </Card>
        ))}
      </div>
      {newCases.length > 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="new-cases">
          {plural(newCases.length, "case")} in the suite {newCases.length === 1 ? "is" : "are"} new to this climb:{" "}
          {newCases.map((entry) => entry.key).join(", ")}. {newCases.length === 1 ? "It joins" : "They join"} steering from
          the next round unless you set {newCases.length === 1 ? "it" : "them"} aside for confirmation.
        </p>
      ) : null}
    </section>
  );
}
