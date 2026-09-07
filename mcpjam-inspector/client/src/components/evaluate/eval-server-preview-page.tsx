/**
 * First-run screen after "Eval my server".
 *
 * Two steps: review the suites we'd run, then confirm clients. Suites,
 * cases, and findings are a preview until generation and discovery are
 * wired. Case clicks use today's case editor and return here.
 */
import { useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Info, Plus, Trash2, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { cn } from "@mcpjam/design-system/cn";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { ProgressStepper } from "@/components/shared/progress-stepper";
import { HostChipLogo } from "@/components/hosts/host-chip";
import { resolveHostLogoByName } from "@/lib/host-logo";
import { toast } from "@/lib/toast";
import {
  SUITE_IMPORT_UNAVAILABLE_MESSAGE,
  SuiteEmptyCasesHero,
} from "./suite-detail-overview";
import {
  ADDABLE_FIRST_RUN_CLIENTS,
  DEFAULT_FIRST_RUN_CLIENTS,
  DEFAULT_FIRST_RUN_ITERATIONS,
  addPreviewCase,
  buildEvalServerPreview,
  createDraftPreviewCase,
  createDraftPreviewSuite,
  previewCaseCount,
  removePreviewCase,
  removePreviewSuite,
  type EvalServerPreview,
  type FirstRunClient,
  type PreviewCase,
  type PreviewFinding,
  type PreviewSuite,
} from "./eval-server-preview-model";
import {
  readEvalServerPreviewDraft,
  writeEvalServerPreviewDraft,
  type EvalServerPreviewStep,
} from "./eval-server-preview-state";

export type EvalServerPreviewCaseTarget = {
  suiteId: string;
  caseId: string;
  title: string;
};

const FLOW_STEPS = [
  { id: "suites", label: "Review suites and findings" },
  { id: "confirm", label: "Confirm run" },
] as const;

interface EvalServerPreviewPageProps {
  server: { id: string; name: string };
  /** Override the fixture. Engineering will pass generated data here. */
  preview?: EvalServerPreview;
  onOpenCase: (target: EvalServerPreviewCaseTarget) => void;
  onRunFirstEvals: (input: { iterationsPerCase: number }) => void;
}

export function EvalServerPreviewPage({
  server,
  preview: previewProp,
  onOpenCase,
  onRunFirstEvals,
}: EvalServerPreviewPageProps) {
  const initial = previewProp ?? buildEvalServerPreview(server);
  const stored = previewProp ? null : readEvalServerPreviewDraft(server.id);

  const [suites, setSuites] = useState(stored?.suites ?? initial.suites);
  const [step, setStep] = useState<EvalServerPreviewStep>(
    stored?.step ?? "suites",
  );
  const [addCasesSuiteId, setAddCasesSuiteId] = useState<string | null>(null);
  const [clients, setClients] = useState<FirstRunClient[]>(
    () => stored?.clients ?? [...DEFAULT_FIRST_RUN_CLIENTS],
  );
  const [openSuiteIds, setOpenSuiteIds] = useState<string[]>(
    stored?.openSuiteIds ?? [],
  );
  const [iterationsPerCase, setIterationsPerCase] = useState(
    stored?.iterationsPerCase ?? DEFAULT_FIRST_RUN_ITERATIONS,
  );

  const persist = (next: {
    suites?: PreviewSuite[];
    openSuiteIds?: string[];
    step?: EvalServerPreviewStep;
    clients?: FirstRunClient[];
    iterationsPerCase?: number;
  }) => {
    writeEvalServerPreviewDraft(server.id, {
      suites: next.suites ?? suites,
      openSuiteIds: next.openSuiteIds ?? openSuiteIds,
      step: next.step ?? step,
      clients: next.clients ?? clients,
      iterationsPerCase: next.iterationsPerCase ?? iterationsPerCase,
    });
  };

  const preview: EvalServerPreview = useMemo(
    () => ({ ...initial, suites }),
    [initial, suites],
  );
  const caseCount = previewCaseCount(preview);
  const addCasesSuite = suites.find((suite) => suite.id === addCasesSuiteId);
  const activeIndex = step === "confirm" ? 1 : 0;

  const addSuite = () => {
    const draft = createDraftPreviewSuite(suites.length + 1);
    const nextSuites = [...suites, draft];
    const nextOpen = openSuiteIds.includes(draft.id)
      ? openSuiteIds
      : [...openSuiteIds, draft.id];
    setSuites(nextSuites);
    setOpenSuiteIds(nextOpen);
    persist({ suites: nextSuites, openSuiteIds: nextOpen });
  };

  const deleteSuite = (suiteId: string) => {
    const nextSuites = removePreviewSuite(suites, suiteId);
    const nextOpen = openSuiteIds.filter((id) => id !== suiteId);
    setSuites(nextSuites);
    setOpenSuiteIds(nextOpen);
    if (addCasesSuiteId === suiteId) setAddCasesSuiteId(null);
    persist({ suites: nextSuites, openSuiteIds: nextOpen });
  };

  const deleteCase = (suiteId: string, caseId: string) => {
    const nextSuites = removePreviewCase(suites, suiteId, caseId);
    setSuites(nextSuites);
    persist({ suites: nextSuites });
  };

  const openCase = (target: EvalServerPreviewCaseTarget) => {
    persist({ suites, openSuiteIds, step: "suites", clients, iterationsPerCase });
    onOpenCase(target);
  };

  const describeCase = (suiteId: string) => {
    const draftCase = createDraftPreviewCase();
    const nextSuites = addPreviewCase(suites, suiteId, draftCase);
    const nextOpen = openSuiteIds.includes(suiteId)
      ? openSuiteIds
      : [...openSuiteIds, suiteId];
    setSuites(nextSuites);
    setOpenSuiteIds(nextOpen);
    setAddCasesSuiteId(null);
    persist({
      suites: nextSuites,
      openSuiteIds: nextOpen,
      step: "suites",
    });
    onOpenCase({
      suiteId,
      caseId: draftCase.id,
      title: draftCase.title,
    });
  };

  const goToStep = (next: EvalServerPreviewStep) => {
    setAddCasesSuiteId(null);
    setStep(next);
    persist({ step: next });
  };

  const stepper = (
    <ProgressStepper
      steps={FLOW_STEPS}
      activeIndex={activeIndex}
      onStepSelect={(index) => {
        const next = FLOW_STEPS[index];
        if (!next) return;
        goToStep(next.id);
      }}
      isStepSelectable={(index) => index === 0 && step === "confirm"}
      ariaLabel="First eval progress"
      testId="eval-server-preview-stepper"
      className="w-full"
    />
  );

  if (addCasesSuite) {
    return (
      <PreviewShell stepper={stepper} testId="eval-server-preview-add-cases">
        <button
          type="button"
          onClick={() => setAddCasesSuiteId(null)}
          className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-primary hover:text-primary/80"
        >
          <ChevronLeft className="size-4" aria-hidden />
          Back
        </button>
        <p className="mt-4 text-sm text-muted-foreground">{addCasesSuite.title}</p>
        <div className="mt-4">
          <SuiteEmptyCasesHero
            readOnly={false}
            fillRemaining={false}
            canGenerate={false}
            isGenerating={false}
            hideGenerate
            onDescribe={() => describeCase(addCasesSuite.id)}
            onImport={() => {
              toast.info(SUITE_IMPORT_UNAVAILABLE_MESSAGE);
            }}
          />
        </div>
      </PreviewShell>
    );
  }

  if (step === "confirm") {
    return (
      <ConfirmRunStep
        stepper={stepper}
        clients={clients}
        iterationsPerCase={iterationsPerCase}
        onBack={() => goToStep("suites")}
        onClientsChange={(next) => {
          setClients(next);
          persist({ clients: next });
        }}
        onIterationsChange={(next) => {
          setIterationsPerCase(next);
          persist({ iterationsPerCase: next });
        }}
        onRunFirstEvals={() => onRunFirstEvals({ iterationsPerCase })}
      />
    );
  }

  return (
    <PreviewShell stepper={stepper}>
      <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
        Here are the suites we'd run first.
      </h1>
      <p
        className="mt-2 text-sm text-muted-foreground"
        data-testid="eval-server-preview-meta"
      >
        {preview.serverName} · {caseCount} {caseCount === 1 ? "case" : "cases"}
      </p>

      <ol className="mt-8 border-t border-border/40">
        {suites.map((suite) => (
          <PreviewSuiteRow
            key={suite.id}
            suite={suite}
            open={openSuiteIds.includes(suite.id)}
            onToggle={() => {
              const next = openSuiteIds.includes(suite.id)
                ? openSuiteIds.filter((id) => id !== suite.id)
                : [...openSuiteIds, suite.id];
              setOpenSuiteIds(next);
              persist({ openSuiteIds: next });
            }}
            onOpenCase={openCase}
            onAddCases={() => setAddCasesSuiteId(suite.id)}
            onRemoveSuite={() => deleteSuite(suite.id)}
            onRemoveCase={(caseId) => deleteCase(suite.id, caseId)}
          />
        ))}
      </ol>

      <div className="mt-4">
        <button
          type="button"
          onClick={addSuite}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary/80"
        >
          <Plus className="size-3.5" aria-hidden />
          Add a suite
        </button>
      </div>

      {preview.findings.length > 0 ? (
        <section className="mt-10" data-testid="eval-server-preview-findings">
          <h2 className="text-sm font-semibold tracking-tight text-foreground">
            What else we found so far
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            From connecting and reading the server. These are not eval
            results.
          </p>
          <ul className="mt-4 space-y-3">
            {preview.findings.map((finding) => (
              <PreviewFindingRow key={finding.id} finding={finding} />
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mt-12 flex justify-end">
        <Button
          type="button"
          onClick={() => goToStep("confirm")}
          data-testid="eval-server-preview-continue"
        >
          Continue
        </Button>
      </div>
    </PreviewShell>
  );
}

function PreviewShell({
  stepper,
  children,
  testId = "eval-server-preview",
}: {
  stepper: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-auto"
      data-testid={testId}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col px-6 py-8 sm:px-8">
        {stepper}
        <div className="mt-8">{children}</div>
      </div>
    </div>
  );
}

function PreviewSuiteRow({
  suite,
  open,
  onToggle,
  onOpenCase,
  onAddCases,
  onRemoveSuite,
  onRemoveCase,
}: {
  suite: PreviewSuite;
  open: boolean;
  onToggle: () => void;
  onOpenCase: (target: EvalServerPreviewCaseTarget) => void;
  onAddCases: () => void;
  onRemoveSuite: () => void;
  onRemoveCase: (caseId: string) => void;
}) {
  const panelId = `${suite.id}-cases`;
  const empty = suite.cases.length === 0;

  return (
    <li className="border-b border-border/40" data-testid="eval-server-preview-suite">
      <div className="flex items-start gap-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-start gap-3 py-5 text-left"
        >
          <ChevronRight
            className={cn(
              "mt-1 size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-4">
              <span className="text-base font-semibold tracking-tight text-foreground">
                {suite.title}
              </span>
              <span className="shrink-0 text-sm text-muted-foreground">
                {empty
                  ? "No cases"
                  : `${suite.cases.length} ${suite.cases.length === 1 ? "case" : "cases"}`}
              </span>
            </span>
            {suite.description ? (
              <span className="mt-1 block text-sm text-muted-foreground">
                {suite.description}
              </span>
            ) : null}
          </span>
        </button>
        <button
          type="button"
          aria-label={`Remove ${suite.title}`}
          onClick={onRemoveSuite}
          className="mt-4 shrink-0 rounded-md p-2 text-muted-foreground hover:bg-muted/60 hover:text-destructive"
          data-testid="eval-server-preview-remove-suite"
        >
          <Trash2 className="size-4" aria-hidden />
        </button>
      </div>
      {open ? (
        <div id={panelId} className="mb-4 ml-7">
          {empty ? (
            <button
              type="button"
              onClick={onAddCases}
              className="text-sm font-medium text-primary hover:text-primary/80"
              data-testid="eval-server-preview-add-cases"
            >
              Add cases
            </button>
          ) : (
            <ul className="space-y-0.5">
              {suite.cases.map((previewCase) => (
                <PreviewCaseRow
                  key={previewCase.id}
                  suiteId={suite.id}
                  previewCase={previewCase}
                  onOpenCase={onOpenCase}
                  onRemoveCase={() => onRemoveCase(previewCase.id)}
                />
              ))}
              <li>
                <button
                  type="button"
                  onClick={onAddCases}
                  className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-sm font-medium text-primary hover:bg-muted/40"
                  data-testid="eval-server-preview-add-cases"
                >
                  Add cases
                </button>
              </li>
            </ul>
          )}
        </div>
      ) : null}
    </li>
  );
}

function PreviewCaseRow({
  suiteId,
  previewCase,
  onOpenCase,
  onRemoveCase,
}: {
  suiteId: string;
  previewCase: PreviewCase;
  onOpenCase: (target: EvalServerPreviewCaseTarget) => void;
  onRemoveCase: () => void;
}) {
  return (
    <li className="flex items-center gap-1">
      <button
        type="button"
        onClick={() =>
          onOpenCase({
            suiteId,
            caseId: previewCase.id,
            title: previewCase.title,
          })
        }
        className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        data-testid="eval-server-preview-case"
      >
        {previewCase.title}
      </button>
      <button
        type="button"
        aria-label={`Remove ${previewCase.title}`}
        onClick={onRemoveCase}
        className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted/60 hover:text-destructive"
        data-testid="eval-server-preview-remove-case"
      >
        <Trash2 className="size-3.5" aria-hidden />
      </button>
    </li>
  );
}

/**
 * Same severity chrome as ErrorCard (info / warning), without the
 * copy / details / docs chrome that card uses for runtime failures.
 */
function PreviewFindingRow({ finding }: { finding: PreviewFinding }) {
  const warning = finding.severity === "warning";
  const Icon = warning ? AlertTriangle : Info;

  return (
    <li
      role="status"
      data-testid="eval-server-preview-finding"
      data-source={finding.source}
      data-severity={finding.severity}
      className={cn(
        "rounded-md border p-3 text-sm",
        warning
          ? "border-warning/40 bg-warning/10 text-warning"
          : "border-info/40 bg-info/10 text-info",
      )}
    >
      <div className="flex items-start gap-2">
        <Icon
          className={cn(
            "mt-0.5 size-4 shrink-0",
            warning ? "text-warning" : "text-info",
          )}
          aria-hidden
        />
        <div className="min-w-0 space-y-1">
          <p className="font-medium leading-tight">{finding.title}</p>
          <p className="text-foreground/80 leading-snug">{finding.body}</p>
        </div>
      </div>
    </li>
  );
}

function ConfirmRunStep({
  stepper,
  clients,
  iterationsPerCase,
  onBack,
  onClientsChange,
  onIterationsChange,
  onRunFirstEvals,
}: {
  stepper: ReactNode;
  clients: FirstRunClient[];
  iterationsPerCase: number;
  onBack: () => void;
  onClientsChange: (clients: FirstRunClient[]) => void;
  onIterationsChange: (iterations: number) => void;
  onRunFirstEvals: () => void;
}) {
  const addable = ADDABLE_FIRST_RUN_CLIENTS.filter(
    (client) => !clients.some((selected) => selected.id === client.id),
  );

  return (
    <PreviewShell stepper={stepper} testId="eval-server-preview-confirm">
      <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
        Confirm run
      </h1>
      <p className="mt-6 text-sm text-muted-foreground">
        This first run is exploratory. See how the suites behave across
        clients before you tighten anything. Later runs can set threshold
        limits, change iterations, and narrow what counts as a pass.
      </p>
      <p className="mt-3 text-sm text-muted-foreground">
        ChatGPT and Claude are already selected. Add another client if you
        want a wider first pass.
      </p>

      <div
        className="mt-6 flex flex-wrap items-center gap-2"
        data-testid="eval-server-preview-clients"
      >
        {clients.map((client) => (
          <span
            key={client.id}
            className="inline-flex items-center gap-1.5 rounded-full border border-primary/35 bg-primary/8 py-1 pl-2.5 pr-1 text-[12px]"
          >
            <HostChipLogo
              logoSrc={resolveHostLogoByName(client.name)}
              name={client.name}
              size="sm"
            />
            <span className="font-medium leading-tight text-foreground">
              {client.name}
            </span>
            <button
              type="button"
              aria-label={`Remove ${client.name}`}
              onClick={() =>
                onClientsChange(clients.filter((entry) => entry.id !== client.id))
              }
              className="rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}

        {addable.length > 0 ? (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-2.5 py-1 text-sm font-medium text-muted-foreground hover:border-foreground/30 hover:text-foreground"
              >
                <Plus className="size-3.5" aria-hidden />
                Add a client
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-56 p-1">
              {addable.map((client) => (
                <button
                  key={client.id}
                  type="button"
                  onClick={() => onClientsChange([...clients, client])}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/60"
                >
                  <HostChipLogo
                    logoSrc={resolveHostLogoByName(client.name)}
                    name={client.name}
                    size="sm"
                  />
                  {client.name}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        ) : null}
      </div>

      <div className="mt-8" data-testid="eval-server-preview-iterations">
        <Label htmlFor="eval-server-iterations" className="text-sm font-medium">
          Iterations per case
        </Label>
        <Input
          id="eval-server-iterations"
          type="number"
          min={1}
          max={10}
          value={iterationsPerCase}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (!Number.isFinite(next)) return;
            onIterationsChange(Math.min(10, Math.max(1, Math.trunc(next))));
          }}
          className="mt-2 w-24"
        />
        <p className="mt-2 text-sm text-muted-foreground">
          Default is {DEFAULT_FIRST_RUN_ITERATIONS}. Leave it if you are just
          looking around.
        </p>
      </div>

      <div className="mt-10 flex items-center justify-end gap-3">
        <Button
          type="button"
          variant="secondary"
          onClick={onBack}
          data-testid="eval-server-preview-back"
        >
          Back
        </Button>
        <Button
          type="button"
          onClick={onRunFirstEvals}
          data-testid="eval-server-preview-run"
        >
          Run first evals
        </Button>
      </div>
    </PreviewShell>
  );
}
