/**
 * The plugin surface a run executed with (INS-5).
 *
 * A pinned plugin is invisible everywhere else on a run: its MCP servers appear
 * as ordinary servers and its skills as ordinary skills, so "which bundle
 * produced this transcript?" had no answer once the plugin was re-imported. The
 * run snapshot has carried the answer since BE-5; this is where it is said.
 *
 * PROVENANCE, NOT A PIN. Everything rendered here is the run's immutable
 * record — `configSnapshot.environmentPluginVersions`, exactly as frozen. It is
 * deliberately read-only and deliberately offers no "restore these versions"
 * affordance: a run records what ran, and treating that record as a restorable
 * pin is how the ephemeral Playground override would quietly become persistent.
 *
 * The bundle hash is what makes it useful. Two runs of the "same" plugin are
 * the same run only if the hashes match, and a name plus a version id cannot
 * tell you that — a re-import mints a new version id for identical content, and
 * an edit changes content under an unchanged name.
 */
import { shortBundleHash } from "@/components/plugins/plugin-presentation";
import { RunDescriptionOverrideDisclosure } from "../evaluate/run-description-override-disclosure";
import { runDetailMetaLabelClass } from "./run-detail-typography";

export type RunPluginVersionRef = {
  pluginId: string;
  pluginVersionId: string;
  name: string;
  bundleHash: string;
};

export function RunPluginSnapshot({
  pluginVersions,
  skillsExcluded,
  toolDescriptionOverride,
}: {
  pluginVersions?: RunPluginVersionRef[];
  skillsExcluded?: boolean;
  toolDescriptionOverride?: { toolName: string };
}) {
  const versions = pluginVersions ?? [];
  // Absence is semantic: a run with no pinned plugins should say nothing, not
  // render an empty "Plugins" row that reads like a failure to load one.
  //
  // `skillsExcluded` is NOT covered by that: it is a fact about the run, not
  // about plugins, and the common "without skills" arm pins no plugins at all —
  // so returning early on an empty plugin list used to hide the badge in
  // exactly the case it exists for.
  if (versions.length === 0 && !skillsExcluded && !toolDescriptionOverride) {
    return null;
  }

  return (
    <>
      {versions.length > 0 || skillsExcluded ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {versions.length > 0 ? (
            <span className={runDetailMetaLabelClass}>Plugins</span>
          ) : null}
          {versions.map((version) => (
            <span
              key={version.pluginVersionId}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-0.5 text-xs"
              title={`Plugin version ${version.pluginVersionId} · bundle ${version.bundleHash}`}
            >
              <span className="text-foreground">{version.name}</span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {shortBundleHash(version.bundleHash)}
              </span>
            </span>
          ))}
          {skillsExcluded ? (
            // A skill-less run and a run whose skills failed to load look identical
            // in a transcript. Say which this is.
            <span
              className="inline-flex items-center rounded-md border border-border/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
              title="This run is the 'without skills' arm of a compare: no skills were pinned from any channel. The plugins' MCP servers were still connected."
            >
              skills excluded
            </span>
          ) : null}
        </div>
      ) : null}
      {toolDescriptionOverride ? (
        <RunDescriptionOverrideDisclosure
          toolName={toolDescriptionOverride.toolName}
        />
      ) : null}
    </>
  );
}
