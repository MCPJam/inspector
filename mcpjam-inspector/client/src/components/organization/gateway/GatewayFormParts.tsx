import { CheckCircle2, TriangleAlert, XCircle } from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import { RadioGroup, RadioGroupItem } from "@mcpjam/design-system/radio-group";
import type { GatewayTestOutcome } from "./gateway-test-outcome";
import type { GatewayRuntimeLocation } from "./gateway-works-with";

const OUTCOME_ICONS = {
  success: CheckCircle2,
  warning: TriangleAlert,
  destructive: XCircle,
};

/** What the Test found, which side ran it, and the fix when there is one. */
export function GatewayTestAlert({
  outcome,
  onUseInspector,
}: {
  outcome: GatewayTestOutcome;
  onUseInspector: () => void;
}) {
  const Icon = OUTCOME_ICONS[outcome.tone];
  return (
    <Alert variant={outcome.tone}>
      <Icon />
      <AlertTitle>{outcome.title}</AlertTitle>
      <AlertDescription>
        {outcome.message ? <p>{outcome.message}</p> : null}
        {outcome.testedFrom ? (
          <p className="text-xs">{outcome.testedFrom}</p>
        ) : null}
        {outcome.offerInspector ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onUseInspector}
          >
            Make calls from each user's Inspector
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

const RUNTIME_OPTIONS: Array<[GatewayRuntimeLocation, string, string]> = [
  [
    "cloud",
    "MCPJam's servers",
    "Every feature can use it. MCPJam's servers must be able to reach the gateway.",
  ],
  [
    "local",
    "Each user's Inspector",
    "For a gateway only your network reaches. Judges and harness clients can't use it.",
  ],
];

/** Where the connection's calls come from: the `runtimeLocation` it saves. */
export function GatewayRuntimeField({
  value,
  onChange,
}: {
  value: GatewayRuntimeLocation;
  onChange: (value: GatewayRuntimeLocation) => void;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="pb-1 text-sm font-medium">Calls come from</legend>
      <RadioGroup
        aria-label="Calls come from"
        value={value}
        onValueChange={(next) => onChange(next as GatewayRuntimeLocation)}
        className="grid gap-3 sm:grid-cols-2"
      >
        {RUNTIME_OPTIONS.map(([option, title, description]) => (
          <Label
            key={option}
            htmlFor={`gateway-runtime-${option}`}
            className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent"
          >
            <RadioGroupItem id={`gateway-runtime-${option}`} value={option} />
            <span className="space-y-1">
              <span className="block text-sm">{title}</span>
              <span className="block text-xs font-normal text-muted-foreground">
                {description}
              </span>
            </span>
          </Label>
        ))}
      </RadioGroup>
    </fieldset>
  );
}
