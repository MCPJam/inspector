/**
 * Full-page Describe step skeleton for New swarm.
 * Step trail + composer + environment picker + intensity — no generate/run wiring yet.
 */
import { Fragment, useMemo, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@mcpjam/design-system/breadcrumb";
import { Label } from "@mcpjam/design-system/label";
import { McpjamAgentComposer } from "@/components/mcpjam-agent/McpjamAgentComposer";
import { EnvironmentPicker } from "@/components/project-environments/environment-picker";
import { MAX_ENVIRONMENTS_PER_JOURNEY } from "@/components/swarms/journey-environments";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import { cn } from "@/lib/utils";

const CREATE_STEPS = [
  "Describe",
  "Confirm personas",
  "Running",
  "Findings",
] as const;

const ACTIVE_STEP_INDEX = 0;

const DESCRIBE_PLACEHOLDER =
  "Finance ops reconciling payouts, and devs wiring up subscription billing.";

type SwarmPushIntensity = "quick" | "standard" | "launch";

const PUSH_INTENSITY_OPTIONS: ReadonlyArray<{
  value: SwarmPushIntensity;
  label: string;
  detail: string;
}> = [
  {
    value: "quick",
    label: "Quick look",
    detail: "3 personas · 15 sessions · ~1 min",
  },
  {
    value: "standard",
    label: "Standard",
    detail: "6 personas · 36 sessions · ~4 min",
  },
  {
    value: "launch",
    label: "Launch gate",
    detail: "12 personas · 120 sessions · ~15 min",
  },
];

export function NewSwarmDescribeSkeleton({
  projectId,
  environments,
  onCancel,
}: {
  projectId: string;
  environments: ProjectEnvironmentView[] | undefined;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [environmentIds, setEnvironmentIds] = useState<string[]>([]);
  const [pushIntensity, setPushIntensity] =
    useState<SwarmPushIntensity>("quick");
  const envList = useMemo(() => environments ?? [], [environments]);

  const canGenerate =
    draft.trim().length > 0 && environmentIds.length > 0;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="new-swarm-describe-skeleton"
    >
      <div className="shrink-0 border-b border-border/60 bg-muted/15 px-4 py-2.5 sm:px-6">
        <div className="flex min-w-0 items-center gap-4">
          <Breadcrumb className="min-w-0 flex-1">
            <BreadcrumbList className="min-w-0 flex-nowrap">
              {CREATE_STEPS.map((label, index) => (
                <Fragment key={label}>
                  {index > 0 ? <BreadcrumbSeparator /> : null}
                  <BreadcrumbItem>
                    {index === ACTIVE_STEP_INDEX ? (
                      <BreadcrumbPage className="font-medium">
                        {label}
                      </BreadcrumbPage>
                    ) : (
                      <span className="text-muted-foreground/70">{label}</span>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0"
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-background">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8 sm:px-8">
          <div className="space-y-2">
            <h2 className="text-2xl font-semibold tracking-[-0.02em] text-foreground">
              Who uses this server, and what do they try to do?
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              One box. We infer the personas, the goals, the clients and a
              scoring rubric — you confirm all of it next.
            </p>
          </div>

          <McpjamAgentComposer
            value={draft}
            onChange={setDraft}
            onSubmit={() => {
              /* Skeleton: generate not wired yet */
            }}
            placeholder={DESCRIBE_PLACEHOLDER}
            minRows={3}
            maxRows={8}
          />

          <div className="space-y-2">
            <Label>Environments</Label>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <EnvironmentPicker
                projectId={projectId}
                value={environmentIds}
                onChange={setEnvironmentIds}
                multi
                max={MAX_ENVIRONMENTS_PER_JOURNEY}
                emptyLabel="No environments · pick one"
                triggerTestId="new-swarm-environments-picker"
                triggerAriaLabel="Attached environments"
              />
            </div>
            {environments === undefined ? (
              <p className="text-sm leading-relaxed text-muted-foreground">
                Loading environments…
              </p>
            ) : envList.length === 0 ? (
              <p className="text-sm leading-relaxed text-muted-foreground">
                Create an environment on the Environments tab first.
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label>How hard to push</Label>
            <div
              role="radiogroup"
              aria-label="How hard to push"
              data-testid="new-swarm-push-intensity"
              className="grid grid-cols-1 gap-1 rounded-xl bg-muted/50 p-1 sm:grid-cols-3"
            >
              {PUSH_INTENSITY_OPTIONS.map((option) => {
                const selected = pushIntensity === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setPushIntensity(option.value)}
                    className={cn(
                      "rounded-lg px-3 py-2.5 text-left transition-colors",
                      selected
                        ? "bg-background shadow-sm ring-1 ring-border/60"
                        : "hover:bg-background/60",
                    )}
                  >
                    <span className="block text-sm font-semibold text-foreground">
                      {option.label}
                    </span>
                    <span className="mt-0.5 block text-sm leading-relaxed text-muted-foreground">
                      {option.detail}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <Button
              type="button"
              disabled={!canGenerate}
              data-testid="new-swarm-generate-personas"
              onClick={() => {
                /* Skeleton: generate not wired yet */
              }}
            >
              Generate personas
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
