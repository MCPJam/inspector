/**
 * The Suite page's pieces for the page-per-layer flow: the page reports
 * results only, and everything editable sits behind Suite settings.
 */
import { Code2, Cpu, Loader2, Play, SlidersHorizontal } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { resolveHostLogoByName } from "@/lib/host-logo";
import { usePreferencesStoreWithDefaults } from "@/stores/preferences/preferences-provider";
import type { SuiteSettingsRouteTab } from "@/lib/eval-route-types";
import { targetKeyLabel } from "@/lib/eval-target-key";
import { modelDisplayName } from "@/lib/model-display-name";
import { useEvaluateNavEnabled } from "../nav/use-evaluate-nav-enabled";
import { openEvalNavPage, useEvalNavPageViewed } from "../nav/eval-nav-link";

/**
 * Whether the Suite page renders for the page-per-layer flow, and how its run
 * rows open. Counts the page view when it does.
 */
export function useSuitePageNav(suiteId: string): {
  navEnabled: boolean;
  openRun: (runId: string) => void;
} {
  const navEnabled = useEvaluateNavEnabled() === true;
  useEvalNavPageViewed("suite", navEnabled);
  return {
    navEnabled,
    openRun: (runId) =>
      openEvalNavPage({ type: "run-detail", suiteId, runId }, "suite"),
  };
}

function openSuiteSettings(suiteId: string, tab: SuiteSettingsRouteTab) {
  openEvalNavPage({ type: "suite-settings", suiteId, tab }, "suite");
}

const PILL_CLASS =
  "inline-flex h-7 max-w-[16rem] items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 text-[12.5px] text-muted-foreground";

/** What the suite last ran against: its models and client, as pills. */
export function SuitePagePills({
  row,
}: {
  /** The newest run's history row; absent before the first run. */
  row?: { client: string | null; models: readonly string[] };
}) {
  const theme = usePreferencesStoreWithDefaults((state) => state.themeMode);
  if (!row) return null;
  const { client } = row;
  const models = row.models.map((key) =>
    targetKeyLabel(key, row.models, (modelId) => modelDisplayName(modelId)),
  );
  if (!client && models.length === 0) return null;
  return (
    <span
      className="flex min-w-0 flex-wrap items-center gap-2"
      data-testid="suite-detail-pills"
    >
      {models.map((model) => (
        <span key={model} className={PILL_CLASS}>
          <Cpu className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{model}</span>
        </span>
      ))}
      {client ? (
        <span className={PILL_CLASS}>
          <img
            src={resolveHostLogoByName(client, theme)}
            alt=""
            className="size-3.5 shrink-0 object-contain"
          />
          <span className="truncate">{client}</span>
        </span>
      ) : null}
    </span>
  );
}

/** Export as SDK and Suite settings; the Run button stays with the page. */
export function SuitePageNavButtons({
  suiteId,
  onExportSdk,
  canEditSuite,
}: {
  suiteId: string;
  onExportSdk?: () => void;
  canEditSuite: boolean;
}) {
  return (
    <>
      {onExportSdk ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8"
          onClick={onExportSdk}
        >
          <Code2 className="size-3.5" aria-hidden /> Export as SDK
        </Button>
      ) : null}
      {canEditSuite ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8"
          data-testid="suite-detail-settings"
          onClick={() => openSuiteSettings(suiteId, "settings")}
        >
          <SlidersHorizontal className="size-3.5" aria-hidden /> Suite settings
        </Button>
      ) : null}
    </>
  );
}

/** Run, which opens the run review like Setup Run did. */
export function SuitePageRunButton({
  disabled,
  busy,
  onClick,
}: {
  disabled: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      className="h-8 gap-1.5"
      disabled={disabled}
      aria-busy={busy}
      onClick={onClick}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
      ) : (
        <Play className="h-3.5 w-3.5 shrink-0" aria-hidden />
      )}
      Run
    </Button>
  );
}

/** Where run history goes before the first run. */
export function SuitePageNoRuns({
  suiteId,
  hasCases,
  canEditSuite,
}: {
  suiteId: string;
  hasCases: boolean;
  canEditSuite: boolean;
}) {
  return (
    <div
      className="flex min-h-[20rem] flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-border/70 px-6 py-12 text-center"
      data-testid="suite-detail-no-runs"
    >
      <h3 className="text-sm font-semibold text-foreground">
        {hasCases ? "No runs yet" : "No test cases yet"}
      </h3>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        {hasCases
          ? "Run the suite and its results show up here."
          : "Add test cases in Suite settings, then run the suite."}
      </p>
      {!hasCases && canEditSuite ? (
        <Button
          type="button"
          size="sm"
          className="mt-4 h-8"
          onClick={() => openSuiteSettings(suiteId, "cases")}
        >
          Add test cases
        </Button>
      ) : null}
    </div>
  );
}
