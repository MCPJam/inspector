import { useMemo, useRef, useState } from "react";
import { Loader2, Play } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@mcpjam/design-system/alert";
import { Button } from "@mcpjam/design-system/button";
import { Card } from "@mcpjam/design-system/card";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@mcpjam/design-system/toggle-group";
import { startClimb, type StartedClimb } from "@/lib/apis/climbs-api";
import { AgentPromptDialog } from "./agent-prompt-dialog";
import { plural } from "./climb-format";
import {
  CONFIRMATION_MINIMUM_CASES,
  PICKER_HINTS,
  PICKER_LABELS,
  SPLIT_COPY,
  COPY,
} from "./climb-copy";
import type { ClimbPicker } from "./climb-types";
import {
  DEFAULT_CREDIT_LIMIT,
  DEFAULT_ROUND_LIMIT,
  agentPrompt,
  defaultClimbServerId,
  hasIssues,
  startIssues,
  startRequest,
  type StartDraft,
  type SuiteServers,
} from "./start-model";

export type StartFormServer = { id: string; name: string };
export type StartFormEnvironment = { id: string; label: string };
export type StartFormModel = { id: string; name: string; disabled?: boolean };

const PICKERS: ClimbPicker[] = ["person", "mcpjam", "agent"];

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-xs text-destructive">
      {message}
    </p>
  );
}

/**
 * Start a climb from a suite: which server, where the cases run, who picks
 * each change, and when to stop. The baseline runs the suite twice in each
 * environment before round 1, which costs credits, so the form says so.
 */
export function StartForm({
  projectId,
  suite,
  caseCount,
  servers,
  environments,
  models,
  onStarted,
  onCancel,
}: {
  projectId: string;
  suite: { id: string; name: string } & SuiteServers;
  caseCount: number;
  servers: StartFormServer[];
  environments: StartFormEnvironment[];
  models: StartFormModel[];
  onStarted: (climb: StartedClimb) => void;
  onCancel?: () => void;
}) {
  const usableModels = useMemo(() => models.filter((model) => !model.disabled), [models]);
  const [draft, setDraft] = useState<StartDraft>(() => ({
    serverId: defaultClimbServerId(suite, servers),
    environmentIds: environments.map((environment) => environment.id),
    picker: "person",
    modelId: usableModels[0]?.id ?? "",
    roundLimit: DEFAULT_ROUND_LIMIT,
    creditLimit: DEFAULT_CREDIT_LIMIT,
  }));
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const inFlight = useRef(false);

  const issues = startIssues(draft, environments.length > 0);
  const shown = submitted ? issues : {};
  const server = servers.find((candidate) => candidate.id === draft.serverId);
  const allEnvironmentIds = environments.map((environment) => environment.id);

  const update = (patch: Partial<StartDraft>) => setDraft((previous) => ({ ...previous, ...patch }));

  const toggleEnvironment = (id: string, on: boolean) =>
    update({
      environmentIds: allEnvironmentIds.filter((candidate) =>
        candidate === id ? on : draft.environmentIds.includes(candidate),
      ),
    });

  const prompt = agentPrompt({
    serverName: server?.name ?? "your server",
    suiteName: suite.name,
    environmentLabels: environments
      .filter((environment) => draft.environmentIds.includes(environment.id))
      .map((environment) => environment.label),
    roundLimit: draft.roundLimit,
    creditLimit: draft.creditLimit,
  });

  const submit = async () => {
    setSubmitted(true);
    if (hasIssues(issues) || inFlight.current) return;
    if (draft.picker === "agent") {
      setPromptOpen(true);
      return;
    }
    inFlight.current = true;
    setPending(true);
    setFailure(null);
    try {
      const climb = await startClimb(
        startRequest(draft, { projectId, suiteId: suite.id, allEnvironmentIds }),
      );
      onStarted(climb);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The climb did not start. Try again.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const mcpjamUnavailable = usableModels.length === 0;
  const splitCopy = caseCount >= CONFIRMATION_MINIMUM_CASES ? SPLIT_COPY.large : SPLIT_COPY.small;

  return (
    <form
      className="mx-auto flex w-full max-w-[600px] flex-col gap-6"
      aria-label="Start a climb"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Start a climb</h1>
        <p className="text-sm text-muted-foreground">
          From the suite {suite.name}, {plural(caseCount, "case")}.
        </p>
      </div>

      <Card className="gap-0 p-0 shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-4 py-3">
          <Label htmlFor="climb-server">Server</Label>
          <div className="flex flex-col items-end gap-1">
            <Select value={draft.serverId} onValueChange={(serverId) => update({ serverId })}>
              <SelectTrigger id="climb-server" className="w-60" aria-invalid={Boolean(shown.serverId)}>
                <SelectValue placeholder="Choose a server" />
              </SelectTrigger>
              <SelectContent>
                {servers.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError id="climb-server-error" message={shown.serverId} />
          </div>
        </div>

        {environments.length > 0 ? (
          <fieldset className="border-b border-border px-4 py-3">
            <legend className="mb-2 text-sm font-medium">Where it runs</legend>
            <div className="flex flex-col gap-2">
              {environments.map((environment) => (
                <label key={environment.id} className="flex items-center gap-3 text-sm">
                  <Checkbox
                    checked={draft.environmentIds.includes(environment.id)}
                    onCheckedChange={(checked) => toggleEnvironment(environment.id, checked === true)}
                  />
                  {environment.label}
                </label>
              ))}
            </div>
            <FieldError id="climb-environments-error" message={shown.environmentIds} />
          </fieldset>
        ) : null}

        <div className="border-b border-border px-4 py-3">
          <div className="text-sm font-medium">Cases</div>
          <p className="text-xs text-muted-foreground">{splitCopy}</p>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-4 py-3">
          <div className="min-w-0 max-w-[260px]">
            <Label id="climb-picker-label">Who picks each change</Label>
            <p className="text-xs text-muted-foreground">{PICKER_HINTS[draft.picker]}</p>
          </div>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={draft.picker}
            onValueChange={(value) => value && update({ picker: value as ClimbPicker })}
            aria-labelledby="climb-picker-label"
            className="w-fit shrink-0"
          >
            {PICKERS.map((picker) => (
              <ToggleGroupItem
                key={picker}
                value={picker}
                className="flex-none whitespace-nowrap px-3"
                disabled={picker === "mcpjam" && mcpjamUnavailable}
              >
                {PICKER_LABELS[picker]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
        {mcpjamUnavailable ? (
          <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
            MCPJam needs a model to pick with. Add a model provider in Settings to choose it.
          </p>
        ) : null}

        {draft.picker === "mcpjam" ? (
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-4 py-3">
            <div>
              <Label htmlFor="climb-model">{COPY.modelLabel}</Label>
              <p className="text-xs text-muted-foreground">{COPY.modelHint}</p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <Select value={draft.modelId} onValueChange={(modelId) => update({ modelId })}>
                <SelectTrigger id="climb-model" className="w-60" aria-label={COPY.modelLabel}>
                  <SelectValue placeholder="Choose a model" />
                </SelectTrigger>
                <SelectContent>
                  {usableModels.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError id="climb-model-error" message={shown.modelId} />
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3">
          <Label htmlFor="climb-rounds">Stop after</Label>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Input
              id="climb-rounds"
              inputMode="numeric"
              value={draft.roundLimit}
              onChange={(event) => update({ roundLimit: event.target.value })}
              className="w-16"
              aria-invalid={Boolean(shown.roundLimit)}
            />
            rounds or
            <Input
              aria-label="Credits"
              inputMode="numeric"
              value={draft.creditLimit}
              onChange={(event) => update({ creditLimit: event.target.value })}
              className="w-24"
              aria-invalid={Boolean(shown.creditLimit)}
            />
            credits
          </div>
          <div className="flex basis-full flex-col gap-1">
            <FieldError id="climb-rounds-error" message={shown.roundLimit} />
            <FieldError id="climb-credits-error" message={shown.creditLimit} />
          </div>
        </div>
      </Card>

      {failure ? (
        <Alert variant="destructive">
          <AlertTitle>The climb did not start</AlertTitle>
          <AlertDescription>
            <p>{failure}</p>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          The baseline runs every case twice in each environment before round 1.
        </p>
        <div className="flex items-center gap-2">
          {onCancel ? (
            <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
              Back to climbs
            </Button>
          ) : null}
          {draft.picker === "agent" ? (
            <Button type="submit">Copy the prompt for your agent</Button>
          ) : (
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Play aria-hidden />}
              Run the baseline
            </Button>
          )}
        </div>
      </div>

      <AgentPromptDialog
        open={promptOpen}
        onOpenChange={setPromptOpen}
        title="Prompt for your agent"
        note="Rounds appear on the suite's Climb tab as your agent submits them."
        prompt={prompt}
      />
    </form>
  );
}
