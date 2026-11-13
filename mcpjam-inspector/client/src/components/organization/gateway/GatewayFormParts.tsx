import type { ReactNode } from "react";
import { CheckCircle2, TriangleAlert, XCircle } from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { RadioGroup, RadioGroupItem } from "@mcpjam/design-system/radio-group";
import { ProviderKeyField } from "../ProviderKeyField";
import type { GatewayTestOutcome } from "./gateway-test-outcome";
import type { GatewayRuntimeLocation } from "./gateway-works-with";
import { FIELD_IDS, type GatewayDraft } from "./use-gateway-draft";

/** The base URL and key a Test runs with; `action` sits beside the key. */
export function GatewayConnectionFields({
  draft,
  hasSecret,
  action,
}: {
  draft: GatewayDraft;
  /** The saved provider has a key, which an empty key field keeps. */
  hasSecret: boolean;
  action?: ReactNode;
}) {
  const { keyProblem } = draft;
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={FIELD_IDS.baseUrl}>Base URL</Label>
        <Input
          id={FIELD_IDS.baseUrl}
          type="url"
          value={draft.baseUrl}
          onChange={(event) => draft.setBaseUrl(event.target.value)}
          placeholder="https://litellm.example.com/v1"
          aria-invalid={!!keyProblem || draft.outcome?.focus === "baseUrl"}
          aria-describedby={keyProblem ? "gateway-base-url-problem" : undefined}
        />
        {keyProblem ? (
          <p id="gateway-base-url-problem" className="text-sm text-destructive">
            {keyProblem}
          </p>
        ) : null}
      </div>
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <ProviderKeyField
            id={FIELD_IDS.secret}
            configured={hasSecret && !keyProblem && !draft.keyRequested}
            value={draft.secret}
            onChange={draft.setSecret}
            optional={!keyProblem}
          />
        </div>
        {action}
      </div>
    </>
  );
}

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
    "Every feature can use it. MCPJam's servers must be able to reach the provider.",
  ],
  [
    "local",
    "Each user's Inspector",
    "For a provider only your network reaches. Judges and harness clients can't use it.",
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
