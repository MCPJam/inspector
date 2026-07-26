import { useState } from "react";
import { ChevronRight, TriangleAlert } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@/lib/utils";
import type {
  PluginImportPreview,
  PluginSetupRequirement,
} from "@/lib/plugins/plugin-api-types";
import {
  PLUGIN_UNSUPPORTED_EXPLANATION,
  describeUnsupportedKind,
  formatByteSize,
  pluralize,
  shortBundleHash,
} from "./plugin-presentation";

/**
 * The sanitized import preview, rendered for review BEFORE anything is
 * installed (PR INS-2).
 *
 * Two rules drive the layout:
 *
 *  1. Render only what the bundle actually declares. The backend preview omits
 *     empty component groups' contents, and an absent group means the plugin
 *     does not have one — so a section with nothing in it is not rendered at
 *     all rather than shown as an empty shell with a "0" placeholder.
 *  2. Headline first, specifics behind expanders. The primary view is
 *     identity + census + anything requiring attention (warnings, unsupported
 *     components, setup requirements); the per-component detail is one click
 *     away.
 */

function CountChip({ label, value }: { label: string; value: number }) {
  // Absence is semantic: a plugin with no skills should not advertise
  // "0 skills" as though that were a property of the bundle.
  if (value === 0) return null;
  return (
    <Badge variant="secondary" className="font-normal">
      {pluralize(value, label)}
    </Badge>
  );
}

function Section({
  title,
  summary,
  defaultOpen = false,
  testId,
  children,
}: {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  testId?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-md border border-border/60" data-testid={testId}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
          aria-hidden
        />
        <span className="text-sm font-medium">{title}</span>
        {summary ? (
          <span className="ml-auto text-xs text-muted-foreground">
            {summary}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="border-t border-border/60 px-3 py-2">{children}</div>
      ) : null}
    </div>
  );
}

function RequirementLine({ requirement }: { requirement: PluginSetupRequirement }) {
  const kindLabel =
    requirement.kind === "env"
      ? "env"
      : requirement.kind === "header"
        ? "header"
        : "oauth";
  return (
    <li className="flex items-center gap-2 text-xs">
      <code className="rounded bg-muted px-1 py-0.5">{requirement.name}</code>
      <span className="text-muted-foreground">{kindLabel}</span>
      {requirement.required ? null : (
        <span className="text-muted-foreground">optional</span>
      )}
      <span className="ml-auto text-muted-foreground">
        {requirement.serverKey}
      </span>
    </li>
  );
}

export function PluginImportPreviewContent({
  preview,
}: {
  preview: PluginImportPreview;
}) {
  const { identity, counts } = preview;

  return (
    <div className="space-y-3" data-testid="plugin-import-preview">
      {/* Identity */}
      <div className="space-y-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="text-base font-semibold">
            {identity.displayName || identity.name}
          </h3>
          {identity.version ? (
            <span className="text-xs text-muted-foreground">
              v{identity.version}
            </span>
          ) : null}
          <code
            className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
            title="Content-addressed revision identity"
          >
            {shortBundleHash(preview.bundleHash)}
          </code>
        </div>
        {identity.description ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {identity.description}
          </p>
        ) : null}
      </div>

      {/* Census */}
      <div className="flex flex-wrap gap-1.5">
        <CountChip label="skill" value={counts.skills} />
        <CountChip label="MCP server" value={counts.servers} />
        <CountChip label="app mapping" value={counts.apps} />
        <CountChip label="asset" value={counts.assets} />
      </div>

      {/* Warnings — surfaced without an expander: they are the reason a user
          would decline the import. */}
      {preview.warnings.length > 0 ? (
        <div
          className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2"
          data-testid="plugin-preview-warnings"
        >
          <div className="flex items-center gap-2 text-xs font-medium text-amber-700 dark:text-amber-300">
            <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
            {pluralize(preview.warnings.length, "warning")}
          </div>
          <ul className="mt-1.5 space-y-1">
            {preview.warnings.map((warning, index) => (
              <li
                key={`${warning.code}-${index}`}
                className="text-xs text-muted-foreground"
              >
                <code className="text-[11px]">{warning.code}</code>
                {warning.componentKey ? (
                  <span className="ml-1 text-[11px]">
                    ({warning.componentKey})
                  </span>
                ) : null}
                <span className="ml-1">{warning.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Unsupported components. Always visible when present, and always
          described as preserved-not-executed — never as something MCPJam
          runs. */}
      {preview.unsupported.length > 0 ? (
        <div
          className="rounded-md border border-border/60 bg-muted/20 px-3 py-2"
          data-testid="plugin-preview-unsupported"
        >
          <div className="text-xs font-medium">
            {pluralize(preview.unsupported.length, "unsupported component")}
          </div>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {PLUGIN_UNSUPPORTED_EXPLANATION}
          </p>
          <ul className="mt-1.5 space-y-1">
            {preview.unsupported.map((entry, index) => (
              <li
                key={`${entry.kind}-${entry.key}-${index}`}
                className="text-xs text-muted-foreground"
              >
                <span className="font-medium text-foreground">
                  {describeUnsupportedKind(entry.kind)}
                </span>
                <span className="ml-1">{entry.key}</span>
                <span className="ml-1">— {entry.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Setup requirements: names only, values never leave the user's hands. */}
      {preview.setupRequirements.length > 0 ? (
        <Section
          title="Setup required"
          summary={pluralize(preview.setupRequirements.length, "value")}
          defaultOpen
          testId="plugin-preview-setup"
        >
          <p className="mb-1.5 text-[11px] text-muted-foreground">
            The bundle declares these names. MCPJam never reads values from the
            bundle — you provide them per server after installing.
          </p>
          <ul className="space-y-1">
            {preview.setupRequirements.map((requirement, index) => (
              <RequirementLine
                key={`${requirement.serverKey}-${requirement.name}-${index}`}
                requirement={requirement}
              />
            ))}
          </ul>
        </Section>
      ) : null}

      {preview.skills.length > 0 ? (
        <Section
          title="Skills"
          summary={pluralize(preview.skills.length, "skill")}
          testId="plugin-preview-skills"
        >
          <ul className="space-y-2">
            {preview.skills.map((skill) => (
              <li key={skill.modelRef} className="text-xs">
                <code className="rounded bg-muted px-1 py-0.5">
                  {skill.modelRef}
                </code>
                <p className="mt-0.5 text-muted-foreground">
                  {skill.description}
                </p>
                {skill.supportingFileCount > 0 ? (
                  <p className="text-[11px] text-muted-foreground">
                    {pluralize(skill.supportingFileCount, "supporting file")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {preview.servers.length > 0 ? (
        <Section
          title="MCP servers"
          summary={pluralize(preview.servers.length, "server")}
          testId="plugin-preview-servers"
        >
          <ul className="space-y-2">
            {preview.servers.map((server) => (
              <li key={server.key} className="text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{server.key}</span>
                  <Badge variant="outline" className="font-normal">
                    {server.transport}
                  </Badge>
                  {server.oauth?.timing ? (
                    <span className="text-muted-foreground">
                      OAuth {server.oauth.timing.replace("_", " ")}
                    </span>
                  ) : null}
                </div>
                {server.envRequirements?.length ? (
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    env: {server.envRequirements.map((e) => e.name).join(", ")}
                  </p>
                ) : null}
                {server.headerRequirements?.length ? (
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    headers:{" "}
                    {server.headerRequirements.map((h) => h.name).join(", ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {preview.apps.length > 0 ? (
        <Section
          title="App mappings"
          summary={pluralize(preview.apps.length, "mapping")}
          testId="plugin-preview-apps"
        >
          {/* `.app.json` entries are preserved metadata: no component rows, no
              binding, no runtime code (see the plan's "App mappings are
              metadata, not components"). */}
          <p className="mb-1.5 text-[11px] text-muted-foreground">
            Preserved as metadata. App UI still comes from whatever UI
            resources the plugin's MCP servers serve at runtime.
          </p>
          <ul className="space-y-1">
            {preview.apps.map((app, index) => (
              <li
                key={`${app.appId}-${index}`}
                className="flex items-center gap-2 text-xs"
              >
                <code className="rounded bg-muted px-1 py-0.5">
                  {app.appId}
                </code>
                <span className="text-muted-foreground">{app.binding}</span>
                <span className="ml-auto text-muted-foreground">
                  {app.status}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {preview.assets.length > 0 ? (
        <Section
          title="Assets"
          summary={pluralize(preview.assets.length, "asset")}
          testId="plugin-preview-assets"
        >
          <ul className="space-y-1">
            {preview.assets.map((asset, index) => (
              <li
                key={`${asset.kind}-${index}`}
                className="flex items-center gap-2 text-xs text-muted-foreground"
              >
                <span className="font-medium text-foreground">
                  {asset.kind}
                </span>
                <span>{asset.contentType}</span>
                <span className="ml-auto">{formatByteSize(asset.size)}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}
