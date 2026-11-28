import { shortBundleHash } from "@/components/plugins/plugin-presentation";
import { useProjectPlugin, useProjectPlugins } from "@/hooks/usePluginImportApi";
import type { ReactNode } from "react";
import { Button } from "@mcpjam/design-system/button";

/** Directory names as text: no logo is used without permission. */
export const DIRECTORY_NAMES = { claude: "Claude", openai: "ChatGPT" } as const;

export interface RehearsalCounts {
  blockers: number;
  toFix: number;
  likelyFlags: number;
  notChecked: number;
}

const countLabel = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

function CheckResults({ counts }: { counts: RehearsalCounts }) {
  const otherResults = [
    counts.toFix && countLabel(counts.toFix, "field to fill", "fields to fill"),
    counts.likelyFlags &&
      countLabel(counts.likelyFlags, "likely flag", "likely flags"),
    counts.notChecked && `${counts.notChecked} unchecked`,
  ].filter(Boolean);
  return (
    <>
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-medium text-foreground">
        {counts.blockers > 0 && (
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full bg-destructive"
          />
        )}
        {counts.blockers
          ? countLabel(counts.blockers, "blocker", "blockers")
          : "No blockers found"}
      </span>
      {otherResults.map((label) => (
        <span key={label} className="whitespace-nowrap">
          <span aria-hidden="true" className="mr-1.5">
            ·
          </span>
          {label}
        </span>
      ))}
    </>
  );
}

/** The button says which saved test plan revision pressing it authorizes. */
function runLabel(hasRun: boolean, planRevision?: number): string {
  if (planRevision === undefined) {
    return hasRun ? "Run checks again" : "Run checks";
  }
  return hasRun
    ? `Run checks again with test plan revision ${planRevision}`
    : `Run checks with test plan revision ${planRevision}`;
}

export function ChatGptPackageTitle({
  projectId,
  pluginId,
  versionId,
}: {
  projectId: string | null;
  pluginId?: string;
  versionId?: string;
}) {
  const plugins = useProjectPlugins(projectId);
  const plugin = plugins?.find((entry) => entry.pluginId === pluginId);
  const detail = useProjectPlugin(plugin?.pluginId);
  const version = detail?.versions.find((entry) => entry.pluginVersionId === versionId);
  const versionLabel = version && (version.declaredVersion || shortBundleHash(version.bundleHash));

  return (
    <>
      ChatGPT plugin package
      {plugin && (
        <span className="ml-2 break-words font-normal">
          {plugin.displayName}{versionLabel && ` · ${versionLabel}`}
        </span>
      )}
    </>
  );
}

export function RehearsalBar({
  title,
  counts,
  server,
  packageAction,
  status,
  provenance,
  canRun,
  running,
  hasRun,
  planRevision,
  onRun,
}: {
  title: ReactNode;
  /** The last run's totals; `null` before a run has completed. */
  counts: RehearsalCounts | null;
  server: ReactNode;
  packageAction?: ReactNode;
  status?: string;
  provenance?: string;
  canRun: boolean;
  running: boolean;
  hasRun: boolean;
  /** The saved test plan revision a run starts with, and so authorizes. */
  planRevision?: number;
  onRun: () => void;
}) {
  return (
    <section
      aria-label="Readiness checks"
      className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-background px-4 py-2.5"
    >
      <div className="min-w-0 flex-[1_1_15rem]">
        <p title={provenance} className="text-sm font-semibold text-foreground">
          {title}
        </p>
        <p
          role="status"
          className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground"
        >
          {status ??
            (counts ? <CheckResults counts={counts} /> : "Not checked yet")}
        </p>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {packageAction}
        {server}
        <Button
          type="button"
          size="sm"
          disabled={!canRun || running}
          onClick={onRun}
          aria-label={running ? "Checking" : runLabel(hasRun, planRevision)}
        >
          {running ? "Checking…" : hasRun ? "Run checks again" : "Run checks"}
          {planRevision !== undefined && !running && ` · Plan ${planRevision}`}
        </Button>
      </div>
    </section>
  );
}
