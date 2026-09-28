import { useState } from "react";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import type { PlanCatalogEntry } from "@/hooks/useOrganizationBilling";
import { estimateCredits } from "@/lib/pricing-estimate";
const LABELS: Record<string, string> = {
  eval_step: "Eval steps",
  user_testing_prompt: "User testing prompts",
  swarm_prompt: "Swarm prompts",
  insight: "Insights",
  computer_hour: "Computer hours",
};
export function PricingEstimator({ entry }: { entry: PlanCatalogEntry }) {
  const [calls, setCalls] = useState("10");
  const [cost, setCost] = useState("0.01");
  const [units, setUnits] = useState<Record<string, number>>({});
  if (!entry.rateCard) return null;
  const total = estimateCredits(
    entry.rateCard,
    Number(cost),
    Number(calls),
    units,
  );
  return (
    <section
      className="space-y-4 rounded-lg border border-border p-5"
      aria-label="Credit cost estimator"
    >
      <h3 className="text-sm font-semibold">Estimate credit usage</h3>
      <p className="text-sm text-muted-foreground">
        Explore {entry.displayName} usage costs. Enter your expected model cost
        per call and product usage. Actual usage may vary. This estimate does
        not reserve credits.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="estimate-calls">Model calls</Label>
          <Input
            id="estimate-calls"
            type="number"
            min={0}
            step={1}
            value={calls}
            onChange={(e) => setCalls(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="estimate-cost">
            Average model cost per call (USD)
          </Label>
          <Input
            id="estimate-cost"
            type="number"
            min={0}
            step="0.001"
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
        </div>
        {Object.keys(entry.rateCard.platformFees)
          .filter((key) => LABELS[key])
          .map((key) => (
            <div key={key} className="space-y-2">
              <Label htmlFor={`estimate-${key}`}>{LABELS[key]}</Label>
              <Input
                id={`estimate-${key}`}
                type="number"
                min={0}
                step={key === "computer_hour" ? "0.1" : "1"}
                value={units[key] ?? 0}
                onChange={(e) =>
                  setUnits((previous) => ({
                    ...previous,
                    [key]: Number(e.target.value),
                  }))
                }
              />
            </div>
          ))}
      </div>
      <p className="text-xs text-muted-foreground">
        For your own model API key, enter $0 model cost here; your provider
        bills you separately. Product fees still apply.
      </p>
      <p role="status" className="text-sm font-semibold">
        {total === null
          ? "Enter valid, non-negative values."
          : `Estimated usage: ${total.toLocaleString()} credits`}
      </p>
    </section>
  );
}
