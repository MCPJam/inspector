/**
 * The release card: which version is next, where it stands, what is live,
 * and the one button. Details (what's in it, the run, the last release) are
 * one click deeper, never on the surface.
 */

import { Card, CardContent } from "@mcpjam/design-system/card";
import { cn } from "@mcpjam/design-system/cn";
import { ReleaseButton } from "@/components/release-button";
import { StatusDot, type StatusTone } from "@/components/ui";
import { readReleaseCard, type ReleaseCardData } from "@/lib/release-card-data";
import { releaseAction, type ReleaseStatus } from "@/lib/release-status";
import { formatRelativeTime } from "@/lib/format";
import type { ReleasePlan } from "@/lib/changesets";

const STATE: Record<ReleaseStatus["kind"], { word: string; tone: StatusTone }> = {
  ready: { word: "Ready", tone: "success" },
  running: { word: "Running", tone: "running" },
  publishing: { word: "Publishing", tone: "running" },
  stopped: { word: "Stopped", tone: "failure" },
  waiting: { word: "Not started", tone: "warning" },
  idle: { word: "Up to date", tone: "neutral" },
  unknown: { word: "Unknown", tone: "warning" }
};

export function ReleaseCardSkeleton() {
  return (
    <Card className="py-8">
      <CardContent className="space-y-4 px-6 md:px-8">
        <div className="h-3 w-20 animate-pulse rounded bg-muted" />
        <div className="h-12 w-48 animate-pulse rounded bg-muted" />
        <div className="h-3 w-72 animate-pulse rounded bg-muted/60" />
      </CardContent>
    </Card>
  );
}

export async function ReleaseCard() {
  const data = await readReleaseCard();
  const { status } = data;
  const action = releaseAction(status);
  const state = STATE[status.kind];

  return (
    <div className="space-y-3">
      <Card className="py-8">
        <CardContent className="space-y-7 px-6 md:px-8">
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <StatusDot tone={state.tone} />
              {state.word}
            </div>
            <h2 className="font-mono text-4xl font-semibold tracking-tight text-foreground md:text-5xl">
              {headline(status)}
            </h2>
            <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
              {sentence(data)}
            </p>
          </div>

          <LiveFacts live={data.live} />

          {action && "label" in status && status.label ? (
            <ReleaseButton action={action} version={status.label} />
          ) : null}

          {status.kind === "ready" && data.plan ? <WhatsInIt plan={data.plan} /> : null}
        </CardContent>
      </Card>

      {data.lastRelease ? (
        <p className="px-1 text-xs text-muted-foreground">
          Last release{" "}
          <a
            href={data.lastRelease.htmlUrl}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-foreground underline-offset-4 hover:underline"
          >
            {data.lastRelease.tag}
          </a>
          {data.lastRelease.publishedAt
            ? ` · ${formatRelativeTime(data.lastRelease.publishedAt)}`
            : null}
        </p>
      ) : null}
    </div>
  );
}

function headline(status: ReleaseStatus): string {
  switch (status.kind) {
    case "ready":
    case "publishing":
    case "stopped":
    case "waiting":
      return versionText(status.label);
    case "running":
      return status.label ? versionText(status.label) : "Preparing";
    case "idle":
      return "Nothing to release";
    case "unknown":
      return "Can't read main";
  }
}

/** Inspector versions read as tags; package lists stay as they are. */
function versionText(label: string): string {
  return /^\d/.test(label) ? `v${label}` : label;
}

function sentence({ status, typicalMinutes }: ReleaseCardData) {
  const usually = typicalMinutes ? ` Usually takes about ${typicalMinutes} minutes.` : "";
  switch (status.kind) {
    case "ready":
      return `${status.changes} change${status.changes === 1 ? "" : "s"}${status.from ? ` since ${status.from}` : ""}.${usually}`;
    case "running":
      return (
        <>
          {status.label ? "Releasing" : "Versioning the pending changes"}, started{" "}
          {formatRelativeTime(status.run.runStartedAt ?? status.run.createdAt)}
          {status.run.actor ? ` by ${status.run.actor}` : ""}.{" "}
          <RunLink href={status.run.htmlUrl}>Watch the run</RunLink>
        </>
      );
    case "stopped":
      return (
        <>
          The release ended &ldquo;{status.run.conclusion}&rdquo; and nothing reached npm. Fix the
          cause, then retry. <RunLink href={status.run.htmlUrl}>Open the run</RunLink>
        </>
      );
    case "publishing":
      return (
        <>
          Released {formatRelativeTime(status.run.updatedAt)}. npm takes a few minutes to show new
          versions. <RunLink href={status.run.htmlUrl}>Open the run</RunLink>
        </>
      );
    case "waiting":
      return "The version commit is on main, but no release is running for it.";
    case "idle":
      return "No pending changesets on main.";
    case "unknown":
      return status.reason;
  }
}

function RunLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-foreground underline underline-offset-4 hover:text-primary"
    >
      {children}
    </a>
  );
}

function LiveFacts({ live }: { live: ReleaseCardData["live"] }) {
  const facts = [
    { name: "npm", value: live.npm },
    { name: "Hosted app", value: live.hosted },
    { name: "Desktop", value: live.desktop }
  ];
  return (
    <dl className="grid grid-cols-3 gap-4 border-t border-border pt-5 sm:max-w-md">
      {facts.map((f) => {
        const behind = f.value !== null && live.npm !== null && f.value !== live.npm;
        return (
          <div key={f.name}>
            <dt className="text-xs text-muted-foreground">{f.name}</dt>
            <dd
              className={cn(
                "mt-1 font-mono text-sm tabular-nums",
                f.value === null
                  ? "text-muted-foreground"
                  : behind
                    ? "text-warning"
                    : "text-foreground"
              )}
              title={behind ? `Behind npm (${live.npm})` : undefined}
            >
              {f.value ?? "unknown"}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function WhatsInIt({ plan }: { plan: ReleasePlan }) {
  return (
    <details className="group border-t border-border pt-5 text-sm">
      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
        What&rsquo;s in it
      </summary>
      <div className="mt-4 space-y-5">
        <ul className="space-y-1">
          {plan.packages.map((p) => (
            <li key={p.name} className="flex gap-3 font-mono text-xs">
              <span className="w-40 text-foreground">{p.name}</span>
              <span className="tabular-nums text-muted-foreground">
                {p.currentVersion} → <span className="text-foreground">{p.newVersion}</span>
              </span>
            </li>
          ))}
        </ul>
        <ul className="space-y-2">
          {plan.changesets.map((c) => (
            <li key={c.name} className="text-xs leading-relaxed text-muted-foreground">
              {c.description.split(/\r?\n/)[0] || c.name}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
