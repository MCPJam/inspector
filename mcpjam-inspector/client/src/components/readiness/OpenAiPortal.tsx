/**
 * The copy of ChatGPT's plugin page around one plugin submission: the
 * breadcrumb, the plugin's header with the portal's three status chips, the
 * "Metadata & Skills" and "MCPs" tabs, the version toolbar with the "Review
 * information" drawer and the "Submit for review" dialog, and the Findings
 * panel beside each tab. Labels come from the flow where it holds them; the
 * chrome no field carries is copied from the board's captures of the portal.
 *
 * The plugin is one stored in the project, and the chosen version stands for
 * the ZIP the portal takes. Choosing one saves it on the submission at once,
 * guarded like an answer, and a run grades that version.
 */
import { useState, type ReactNode } from "react";
import { ChevronRight, ExternalLink, Upload } from "lucide-react";
import type { DirectoryFlow } from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@mcpjam/design-system/tabs";
import { PluginIcon } from "@/components/plugins/PluginIcon";
import { shortBundleHash } from "@/components/plugins/plugin-presentation";
import type { DirectorySubmissionSession } from "@/hooks/use-directory-submission";
import {
  usePluginVersion,
  useProjectPlugin,
  useProjectPlugins,
} from "@/hooks/usePluginImportApi";
import { usePluginsEnabledState } from "@/hooks/usePluginsEnabled";
import type {
  SubmissionEvent,
  SubmissionView,
} from "@/lib/apis/directory-submissions-api";
import { openResult } from "./McpjamChecks";
import { Chip, FindingsDot, OpenAiFindings } from "./OpenAiFindings";
import { allHold, CONNECTION, OpenAiMcp } from "./OpenAiMcp";
import { OpenAiMetadata, OpenAiSkills } from "./OpenAiMetadata";
import { OpenAiReview } from "./OpenAiReview";
import { OpenAiSubmit } from "./OpenAiSubmit";
import { McpjamNote } from "./PortalWidgets";

const MCP = "mcp";
const LISTING = "listing";
const REVIEWER = "reviewer";
const SUBMIT = "submit";
/**
 * Steps whose results and issues show in a place of their own: MCPs on its
 * tab, the reviewer and submit steps in the drawer and the dialog. The rest
 * show on the first tab.
 */
const OWN_PLACE: readonly string[] = [MCP, REVIEWER, SUBMIT];
const TAB =
  "-mb-px h-auto flex-none rounded-none border-0 border-b-2 border-transparent px-0 pb-2 font-normal text-muted-foreground shadow-none data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-none dark:data-[state=active]:border-foreground dark:data-[state=active]:bg-transparent";

const textOf = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : undefined;

function Status({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-sm text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

/** No plugin yet: the project's stored plugins, each standing for a ZIP. */
function PluginChoice({
  projectId,
  session,
  gone,
}: {
  projectId: string;
  session: DirectorySubmissionSession;
  /** The saved plugin was uninstalled since it was chosen. */
  gone?: boolean;
}) {
  const enabled = usePluginsEnabledState();
  const plugins = useProjectPlugins(projectId);
  let state: string | undefined;
  if (enabled === false) {
    state = "Stored plugins are not turned on for this account. Rehearse a Claude submission instead.";
  } else if (!plugins) {
    state = "Loading this project's plugins…";
  } else if (plugins.length === 0) {
    state = "This project has no plugins. Add one on Connect, then choose it here.";
  }
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-8 py-10">
      <h1 className="text-xl font-semibold">Plugins</h1>
      <McpjamNote>
        Choose the stored plugin to rehearse. Its version stands for the ZIP
        you upload.
      </McpjamNote>
      {gone ? (
        <p role="alert" className="text-sm text-destructive">
          The plugin this rehearsal used is no longer in the project. Choose
          another.
        </p>
      ) : null}
      {state ? <p className="text-sm text-muted-foreground">{state}</p> : null}
      <ul className="divide-y divide-border">
        {(state ? [] : (plugins ?? [])).map((plugin) => (
          <li key={plugin.pluginId} className="flex items-center gap-3 py-3 text-sm">
            <PluginIcon
              icons={plugin.icons}
              className="size-9 rounded-lg"
              fallback={<span className="block size-9 rounded-lg bg-accent" />}
            />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{plugin.displayName}</span>
              <span className="block truncate text-muted-foreground">
                {plugin.description}
              </span>
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={session.pluginSaving}
              onClick={() =>
                void session.setPlugin({
                  pluginId: plugin.pluginId,
                  pluginVersionId: plugin.activeVersionId,
                })
              }
            >
              Choose
            </Button>
          </li>
        ))}
      </ul>
      {session.pluginError ? (
        <p role="alert" className="text-sm text-destructive">
          {session.pluginError}
        </p>
      ) : null}
    </div>
  );
}

export function OpenAiPortal({
  flow,
  view,
  session,
  projectId,
  serverUrl,
  onClose,
}: {
  flow: DirectoryFlow;
  view: SubmissionView;
  session: DirectorySubmissionSession;
  projectId: string;
  /** The saved server's URL, which a run grades. */
  serverUrl?: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState(LISTING);
  const [open, setOpen] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<SubmissionEvent | null>(null);
  // Only a plugin still in the project is read: an uninstalled one's
  // detail read fails, and that would take the page down.
  const live = useProjectPlugins(projectId);
  const listed = live?.some((entry) => entry.pluginId === view.pluginId);
  const plugin = useProjectPlugin(listed ? view.pluginId : null);
  const version = usePluginVersion(view.pluginVersionId ?? null);
  if (!view.pluginId || (live && !listed)) {
    return (
      <PluginChoice projectId={projectId} session={session} gone={Boolean(view.pluginId)} />
    );
  }
  const step = (id: string) => flow.steps.find((entry) => entry.id === id);
  const listing = step(LISTING);
  const blocks = listing?.layout?.blocks ?? [];
  const findingsText = blocks.find((block) => block.widget === "findings")?.text ?? {};
  const onTab = (id: string) => (OWN_PLACE.includes(id) ? id : LISTING);
  const placed = (name: string) => view.steps.filter((entry) => onTab(entry.step) === name);
  const results = (name: string) => placed(name).flatMap((entry) => entry.findings);
  const issues = (name: string) => session.issues.filter((issue) => onTab(issue.step) === name);
  const flagged = (name: string) => issues(name).length + results(name).filter(openResult).length > 0;
  const review = step(REVIEWER);
  const submit = step(SUBMIT);
  // The results are this version's only when the run that wrote them graded it.
  const run = session.run.run;
  const resultsRun = run && run.id === view.resultsRunId ? run : undefined;
  const otherVersion = Boolean(
    resultsRun?.pluginVersionId && resultsRun.pluginVersionId !== view.pluginVersionId,
  );
  const checkedAt = resultsRun && !otherVersion ? resultsRun.updatedAt : undefined;
  const configured = allHold(
    results(MCP).filter((entry) => CONNECTION.test(entry.finding.id)),
    checkedAt,
  );
  // The portal connects one server per plugin: the remote one mcp.json declares.
  const server =
    version?.servers.find((entry) => entry.placement === "remote") ?? version?.servers[0];
  const mcp = step(MCP);
  const name = textOf(session.values["listing.displayName"]) ?? plugin?.displayName ?? "";
  const ready = plugin?.versions.filter((entry) => entry.status === "ready") ?? [];
  const panel = (id: string) => (
    <OpenAiFindings
      text={findingsText}
      tab={step(id)?.title ?? ""}
      issues={issues(id)}
      steps={placed(id)}
      hasRun={Boolean(view.resultsRunId)}
    />
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex items-center justify-between border-b border-border px-8 py-3">
        <p className="flex items-center text-lg">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            Plugins
          </button>
          <ChevronRight aria-hidden="true" className="mx-2 size-4 text-muted-foreground" />
          <span className="font-medium">{name}</span>
        </p>
        <Button asChild variant="outline" size="sm">
          <a href={flow.source.url} target="_blank" rel="noreferrer">
            Submission guide
            <ExternalLink aria-hidden="true" />
          </a>
        </Button>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-6 px-8 pt-6">
        <div className="flex items-center gap-4">
          <PluginIcon
            icons={plugin?.icons}
            className="size-12 rounded-xl"
            fallback={<span className="block size-12 rounded-xl bg-accent" />}
          />
          <div>
            <h1 className="text-xl font-semibold">{name}</h1>
            <p className="text-sm text-muted-foreground">
              {textOf(session.values["listing.shortDescription"])}
            </p>
          </div>
        </div>
        <div className="flex gap-8">
          <Status label="MCP configuration">
            <Chip tone={configured ? "good" : "warn"}>
              {configured ? "Configured" : "Configuration incomplete"}
            </Chip>
          </Status>
          <Status label="Review status">
            <Chip>Not submitted</Chip>
          </Status>
          <Status label="Publication">
            <Chip>Not published</Chip>
          </Status>
        </div>
      </div>
      <Tabs value={tab} onValueChange={setTab} className="mt-5 gap-0">
        <TabsList className="h-auto w-full justify-start gap-5 rounded-none border-b border-border bg-transparent p-0 px-8">
          {[LISTING, MCP].map((id) => (
            <TabsTrigger key={id} value={id} className={TAB}>
              {step(id)?.title}
              {flagged(id) ? <FindingsDot /> : null}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={LISTING}>
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted px-8 py-3">
            <Select
              value={view.pluginVersionId ?? ""}
              disabled={session.pluginSaving || ready.length === 0}
              onValueChange={(pluginVersionId) =>
                void session.setPlugin({ pluginId: view.pluginId, pluginVersionId })
              }
            >
              <SelectTrigger aria-label="Version" size="sm" className="bg-background">
                <SelectValue placeholder={plugin ? "No ready version" : "Loading versions…"} />
              </SelectTrigger>
              <SelectContent>
                {ready.map((entry) => (
                  <SelectItem key={entry.pluginVersionId} value={entry.pluginVersionId}>
                    {`${entry.declaredVersion ?? shortBundleHash(entry.bundleHash)} · Draft`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="button" variant="outline" size="sm" disabled>
              <Upload aria-hidden="true" />
              {blocks.find((block) => block.text?.upload)?.text?.upload}
            </Button>
            <McpjamNote>Import a new version of this plugin on Connect.</McpjamNote>
            <div className="ml-auto flex gap-2">
              {review ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setOpen(REVIEWER)}>
                  {review.title}
                  {flagged(REVIEWER) ? <FindingsDot /> : null}
                </Button>
              ) : null}
              {submit ? (
                <Button type="button" size="sm" onClick={() => setOpen(SUBMIT)}>
                  {submit.title}
                </Button>
              ) : null}
            </div>
          </div>
          {session.pluginError || otherVersion ? (
            <p role="alert" className="px-8 pt-3 text-sm text-destructive">
              {session.pluginError ??
                "These results are for another version. Run checks to grade this one."}
            </p>
          ) : null}
          <div className="flex px-8">
            <div className="min-w-0 flex-1 space-y-8 py-6 pr-6">
              {listing ? (
                <>
                  <OpenAiMetadata
                    step={listing}
                    values={session.values}
                    findings={results(LISTING)}
                  />
                  <OpenAiSkills
                    step={listing}
                    findings={results(LISTING)}
                    skills={version?.skills}
                    checkedAt={checkedAt}
                  />
                </>
              ) : null}
            </div>
            {panel(LISTING)}
          </div>
        </TabsContent>
        <TabsContent value={MCP}>
          <div className="border-b border-border bg-muted px-8 py-3">
            <span className="inline-block rounded-md border border-border bg-background px-3 py-1.5 text-sm">
              {server?.componentKey ?? "—"}
            </span>
          </div>
          <div className="flex px-8">
            <div className="min-w-0 flex-1 py-6 pr-6">
              {mcp ? (
                <OpenAiMcp
                  step={mcp}
                  values={session.values}
                  findings={results(MCP)}
                  server={server}
                  serverUrl={serverUrl}
                  checkedAt={checkedAt}
                  canRescan={
                    Boolean(view.pluginVersionId) &&
                    session.run.status !== "running" &&
                    session.run.status !== "unavailable"
                  }
                  onRescan={() => void session.startRun()}
                  onAnswer={session.setAnswer}
                />
              ) : null}
            </div>
            {panel(MCP)}
          </div>
        </TabsContent>
      </Tabs>
      {review ? (
        <OpenAiReview
          key={view.id}
          flow={flow}
          step={review}
          view={view}
          session={session}
          issues={issues(REVIEWER)}
          findings={results(REVIEWER)}
          open={open === REVIEWER}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {submit ? (
        <OpenAiSubmit
          key={view.id}
          step={submit}
          view={view}
          session={session}
          issues={issues(SUBMIT)}
          findings={results(SUBMIT)}
          recorded={recorded?.submissionId === view.id ? recorded : null}
          onRecorded={setRecorded}
          open={open === SUBMIT}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
