/**
 * Scenario widget views: the published-scenario gallery and a single scenario's
 * read-only settings. Share links render with copy (and host-permitting,
 * open) affordances since the URL embeds the access token the hosted UI
 * already exposes to the same audience.
 */
import type { App } from "@modelcontextprotocol/ext-apps";
import { Badge } from "@mcpjam/design-system/badge";
import { Card } from "@mcpjam/design-system/card";
import type {
  GetScenarioResult,
  ListScenariosResult,
  PlatformScenarioSummary,
  PlatformScenarioLink,
} from "@mcpjam/sdk/platform";
import { Globe, Lock, Users } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { MessageBox } from "../shared/app-shell.js";
import { formatTimestamp, humanizeStatus } from "../shared/format.js";
import {
  CopyIconButton,
  OpenLinkButton,
  SectionCard,
  ViewHeader,
} from "./atoms.js";

const MAX_SERVER_CHIPS = 4;

const MODE_PRESENTATIONS: Record<
  string,
  { label: string; icon: ComponentType<{ className?: string }> }
> = {
  project_members: { label: "Project members", icon: Users },
  invited_only: { label: "Invited only", icon: Lock },
  anyone_with_link: { label: "Anyone with link", icon: Globe },
};

export function ScenariosView({
  app,
  isDark,
  payload,
}: {
  app: App | undefined;
  isDark: boolean;
  payload: ListScenariosResult;
}) {
  const scenarios = payload.items;

  return (
    <>
      <ViewHeader
        title={payload.project.name}
        badgeLabel={`${scenarios.length} ${scenarios.length === 1 ? "scenario" : "scenarios"}`}
        isDark={isDark}
      />

      {scenarios.length > 0 ? (
        <section className="grid gap-3 sm:grid-cols-2">
          {scenarios.map((scenario) => (
            <ScenarioCard key={scenario.id} app={app} scenario={scenario} />
          ))}
        </section>
      ) : (
        <MessageBox
          label="No scenarios"
          message="This project has no published scenarios."
        />
      )}
    </>
  );
}

function ScenarioCard({
  app,
  scenario,
}: {
  app: App | undefined;
  scenario: PlatformScenarioSummary;
}) {
  const updatedAt = formatTimestamp(scenario.updatedAt);
  const host = scenario.hostName ?? scenario.hostStyle;

  return (
    <Card className="flex h-full flex-col rounded-xl border border-border/50 bg-card/60 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">
          {scenario.name}
        </h2>
        <ModeBadge mode={scenario.mode} />
      </div>

      {scenario.description ? (
        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
          {scenario.description}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {scenario.serverNames.slice(0, MAX_SERVER_CHIPS).map((name) => (
          <span
            key={name}
            className="rounded border border-border/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
          >
            {name}
          </span>
        ))}
        {scenario.serverNames.length > MAX_SERVER_CHIPS ? (
          <span className="rounded border border-border/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
            +{scenario.serverNames.length - MAX_SERVER_CHIPS} more
          </span>
        ) : null}
        {scenario.serverNames.length === 0 ? (
          <span className="text-xs text-muted-foreground">No servers</span>
        ) : null}
      </div>

      {scenario.link ? (
        <div className="mt-3">
          <ShareLinkRow app={app} link={scenario.link} name={scenario.name} />
        </div>
      ) : null}

      <div className="mt-auto pt-3 text-[11px] text-muted-foreground">
        {host ? <span>Host: {host}</span> : null}
        {host && updatedAt ? <span> · </span> : null}
        {updatedAt ? <span>Updated {updatedAt}</span> : null}
      </div>
    </Card>
  );
}

function ShareLinkRow({
  app,
  link,
  name,
}: {
  app: App | undefined;
  link: PlatformScenarioLink;
  name: string;
}) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-border/50 bg-muted/30 p-2 font-mono text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">{link.url}</span>
      <CopyIconButton
        value={link.url}
        label={`Copy share link for ${name}`}
        className="shrink-0"
      />
      <OpenLinkButton
        app={app}
        url={link.url}
        label={`Open ${name}`}
        className="shrink-0"
      />
    </div>
  );
}

function ModeBadge({ mode }: { mode: string | null }) {
  if (!mode) {
    return null;
  }

  const presentation = MODE_PRESENTATIONS[mode];
  const Icon = presentation?.icon;

  return (
    <Badge variant="secondary" className="shrink-0 gap-1">
      {Icon ? <Icon className="h-3 w-3" /> : null}
      {presentation?.label ?? humanizeStatus(mode)}
    </Badge>
  );
}

export function ScenarioView({
  app,
  isDark,
  payload,
}: {
  app: App | undefined;
  isDark: boolean;
  payload: GetScenarioResult;
}) {
  const scenario = payload.scenario;

  return (
    <>
      <ViewHeader
        title={scenario.name}
        accessory={<ModeBadge mode={scenario.mode} />}
        caption={scenario.description ?? `Scenario · ${payload.project.name}`}
        isDark={isDark}
      />

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <ConfigTile label="Model">
          <span className="break-all font-mono text-sm">
            {scenario.modelId ?? "Default"}
          </span>
        </ConfigTile>
        <ConfigTile label="Temperature">
          <span className="tabular-nums">
            {scenario.temperature ?? "Default"}
          </span>
        </ConfigTile>
        <ConfigTile label="Tool approval">
          {scenario.requireToolApproval ? "Required" : "Automatic"}
        </ConfigTile>
        <ConfigTile label="Host">
          {scenario.hostName ?? scenario.hostStyle ?? "Default"}
        </ConfigTile>
      </section>

      {scenario.link ? (
        <SectionCard title="Share link">
          <ShareLinkRow
            app={app}
            link={scenario.link}
            name={scenario.name}
          />
        </SectionCard>
      ) : null}

      {scenario.systemPrompt ? (
        <SectionCard title="System prompt">
          <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
            {scenario.systemPrompt}
          </pre>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Servers"
        badgeLabel={String(scenario.servers.length)}
      >
        {scenario.servers.length > 0 ? (
          <ul className="flex flex-col">
            {scenario.servers.map((server) => (
              <li
                key={server.id}
                className="flex flex-wrap items-center justify-between gap-2 border-t border-border/50 py-3 first:border-t-0 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {server.name}
                  </div>
                  {server.url ? (
                    <div className="mt-0.5 break-all font-mono text-xs text-muted-foreground">
                      {server.url}
                    </div>
                  ) : null}
                </div>
                {server.useOAuth ? <Badge variant="outline">OAuth</Badge> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No servers attached.</p>
        )}
      </SectionCard>
    </>
  );
}

function ConfigTile({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-muted/30 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 min-w-0 text-sm font-medium">{children}</div>
    </div>
  );
}
