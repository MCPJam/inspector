/**
 * Chatbox widget views: the published-chatbox gallery and a single chatbox's
 * read-only settings. Share links render with copy (and host-permitting,
 * open) affordances since the URL embeds the access token the hosted UI
 * already exposes to the same audience.
 */
import type { App } from "@modelcontextprotocol/ext-apps";
import { Badge } from "@mcpjam/design-system/badge";
import { Card } from "@mcpjam/design-system/card";
import type {
  GetChatboxResult,
  ListChatboxesResult,
  PlatformChatbox,
  PlatformChatboxLink,
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

export function ChatboxesView({
  app,
  isDark,
  payload,
}: {
  app: App | undefined;
  isDark: boolean;
  payload: ListChatboxesResult;
}) {
  const chatboxes = payload.items;

  return (
    <>
      <ViewHeader
        title={payload.project.name}
        badgeLabel={`${chatboxes.length} ${chatboxes.length === 1 ? "chatbox" : "chatboxes"}`}
        isDark={isDark}
      />

      {chatboxes.length > 0 ? (
        <section className="grid gap-3 sm:grid-cols-2">
          {chatboxes.map((chatbox) => (
            <ChatboxCard key={chatbox.id} app={app} chatbox={chatbox} />
          ))}
        </section>
      ) : (
        <MessageBox
          label="No chatboxes"
          message="This project has no published chatboxes."
        />
      )}
    </>
  );
}

function ChatboxCard({
  app,
  chatbox,
}: {
  app: App | undefined;
  chatbox: PlatformChatbox;
}) {
  const updatedAt = formatTimestamp(chatbox.updatedAt);
  const host = chatbox.hostName ?? chatbox.hostStyle;

  return (
    <Card className="flex h-full flex-col rounded-xl border border-border/50 bg-card/60 p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">
          {chatbox.name}
        </h2>
        <ModeBadge mode={chatbox.mode} />
      </div>

      {chatbox.description ? (
        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
          {chatbox.description}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {chatbox.serverNames.slice(0, MAX_SERVER_CHIPS).map((name) => (
          <span
            key={name}
            className="rounded border border-border/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
          >
            {name}
          </span>
        ))}
        {chatbox.serverNames.length > MAX_SERVER_CHIPS ? (
          <span className="rounded border border-border/60 px-1.5 py-0.5 text-[11px] text-muted-foreground">
            +{chatbox.serverNames.length - MAX_SERVER_CHIPS} more
          </span>
        ) : null}
        {chatbox.serverNames.length === 0 ? (
          <span className="text-xs text-muted-foreground">No servers</span>
        ) : null}
      </div>

      {chatbox.link ? (
        <div className="mt-3">
          <ShareLinkRow app={app} link={chatbox.link} name={chatbox.name} />
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
  link: PlatformChatboxLink;
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

export function ChatboxView({
  app,
  isDark,
  payload,
}: {
  app: App | undefined;
  isDark: boolean;
  payload: GetChatboxResult;
}) {
  const chatbox = payload.chatbox;

  return (
    <>
      <ViewHeader
        title={chatbox.name}
        accessory={<ModeBadge mode={chatbox.mode} />}
        caption={chatbox.description ?? `Chatbox · ${payload.project.name}`}
        isDark={isDark}
      />

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <ConfigTile label="Model">
          <span className="break-all font-mono text-sm">
            {chatbox.modelId ?? "Default"}
          </span>
        </ConfigTile>
        <ConfigTile label="Temperature">
          <span className="tabular-nums">
            {chatbox.temperature ?? "Default"}
          </span>
        </ConfigTile>
        <ConfigTile label="Tool approval">
          {chatbox.requireToolApproval ? "Required" : "Automatic"}
        </ConfigTile>
        <ConfigTile label="Host">
          {chatbox.hostName ?? chatbox.hostStyle ?? "Default"}
        </ConfigTile>
      </section>

      {chatbox.link ? (
        <SectionCard title="Share link">
          <ShareLinkRow
            app={app}
            link={chatbox.link}
            name={chatbox.name}
          />
        </SectionCard>
      ) : null}

      {chatbox.systemPrompt ? (
        <SectionCard title="System prompt">
          <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">
            {chatbox.systemPrompt}
          </pre>
        </SectionCard>
      ) : null}

      <SectionCard
        title="Servers"
        badgeLabel={String(chatbox.servers.length)}
      >
        {chatbox.servers.length > 0 ? (
          <ul className="flex flex-col">
            {chatbox.servers.map((server) => (
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
