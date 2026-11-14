import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import "../src/index.css";
import { Button } from "@mcpjam/design-system/button";
import { ServerAuthSummary } from "../src/components/connection/ServerAuthSummary";
import { ConnectionAccountsList } from "../src/components/connection/ConnectionAccountsSection";
import { SignInSharingControl } from "../src/components/connection/SignInSharingControl";
import { SuiteAccountGroups } from "../src/components/evals/suite-accounts-row";
import type { SuiteAccountsView } from "../src/lib/evals/eval-accounts";
import type { OAuthConnection } from "@/shared/oauth-connections";

// The Accounts row saves through Convex. Nothing here is sent unless a box is
// ticked, and then only to an address that does not answer.
const convex = new ConvexReactClient("https://preview.convex.cloud");

const PERSONAL: OAuthConnection[] = [
  {
    connectionId: "personal-1",
    isDefault: true,
    profile: { id: "user-1", email: "you@example.com" },
  },
  {
    connectionId: "personal-2",
    isDefault: false,
    label: "Sandbox workspace",
    profile: { id: "user-2", email: "you@example.com" },
  },
];
const PROJECT: OAuthConnection[] = [
  { connectionId: "project-1", isDefault: true, label: "test-automation-1" },
  {
    connectionId: "project-2",
    isDefault: false,
    label: "test-automation-2",
    needsReauth: true,
  },
];
// What suite settings lists for the same accounts: names, never emails.
const choice = (connection: OAuthConnection, name: string) => ({
  connectionId: connection.connectionId,
  name,
  isDefault: connection.isDefault,
  needsReauth: connection.needsReauth === true,
});
const VIEW: SuiteAccountsView = {
  servers: [
    {
      serverId: "wiki",
      mode: "accounts",
      accounts: [
        choice(PERSONAL[0], "Account 1"),
        choice(PERSONAL[1], "Sandbox workspace"),
      ],
      chosen: null,
    },
    {
      serverId: "tracker",
      mode: "shared",
      accounts: PROJECT.map((row) => choice(row, row.label ?? "")),
      chosen: ["project-2"],
    },
    {
      serverId: "directory",
      mode: "xaa",
      accounts: [],
      chosen: null,
      xaaSubject: "qa-bot",
    },
  ],
  scheduleOwners: [],
};
const SERVER_NAMES: Record<string, string> = {
  wiki: "Wiki",
  tracker: "Task tracker",
  directory: "Directory",
};

const noop = async () => {};

function AuthorizationTab({
  name,
  caption,
  connections,
  shared,
  isAdmin,
}: {
  name: string;
  caption: string;
  connections: OAuthConnection[];
  shared: boolean;
  isAdmin: boolean;
}) {
  return (
    <figure className="space-y-2" data-preview={name}>
      <figcaption className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Authorization tab · {caption}
      </figcaption>
      <div
        className="rounded-lg border border-border bg-background p-4 pr-6"
        style={{ width: 600 }}
      >
        <ServerAuthSummary
          auth={{ method: "oauth", bearer: null, headers: null }}
          reveal={{
            canReveal: false,
            headerNames: [],
            revealed: null,
            isRevealing: false,
            error: null,
            reveal: async () => false,
            reset: () => {},
          }}
          serverKey={name}
          onEditInConfig={() => {}}
        />
        <ConnectionAccountsList
          connections={connections}
          shared={shared}
          canAddAccount
          isAdmin={isAdmin}
          sharingControl={
            isAdmin ? (
              <SignInSharingControl
                shared={shared}
                accountCount={shared ? connections.length : 0}
                onChange={noop}
              />
            ) : null
          }
          onAuthenticate={noop}
          onUpdate={noop}
        />
      </div>
    </figure>
  );
}

function Preview() {
  const params = new URLSearchParams(location.search);
  const [dark, setDark] = useState(params.get("theme") === "dark");
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  return (
    <ConvexProvider client={convex}>
      <div className="min-h-screen bg-background text-foreground">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-8 py-5">
          <div>
            <strong className="text-lg tracking-tight">MCPJam</strong>
            <span className="ml-4 text-xs">
              UI preview · Sample data · Project accounts on a shared server
            </span>
          </div>
          <Button variant="outline" onClick={() => setDark(!dark)}>
            {dark ? "Light mode" : "Dark mode"}
          </Button>
        </header>
        <main className="space-y-8 px-8 py-6">
          {/* Inline: arbitrary-value classes are not generated for this folder. */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "600px 600px",
              gap: 32,
              alignItems: "start",
            }}
          >
            <AuthorizationTab
              name="admin-personal"
              caption="Admin · personal server"
              connections={PERSONAL}
              shared={false}
              isAdmin
            />
            <AuthorizationTab
              name="admin-shared"
              caption="Admin · shared server"
              connections={PROJECT}
              shared
              isAdmin
            />
            <AuthorizationTab
              name="member-shared"
              caption="Member · shared server"
              connections={PROJECT}
              shared
              isAdmin={false}
            />
            <AuthorizationTab
              name="admin-just-shared"
              caption="Admin · just shared, no accounts yet"
              connections={[]}
              shared
              isAdmin
            />
          </div>
          <figure className="space-y-2">
            <figcaption className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Suite settings · Accounts
            </figcaption>
            <div style={{ width: 600 }}>
              <SuiteAccountGroups
                suiteId="preview-suite"
                view={VIEW}
                serverName={(id) => SERVER_NAMES[id] ?? id}
              />
            </div>
          </figure>
        </main>
      </div>
    </ConvexProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
