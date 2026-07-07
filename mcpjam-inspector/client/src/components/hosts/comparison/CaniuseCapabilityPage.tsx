import { useMemo, type ReactNode } from "react";
import { Button } from "@mcpjam/design-system/button";
import { ChevronLeft } from "lucide-react";
import { getChatboxHostLogo } from "@/lib/chatbox-client-style";
import { useClaudeCodeHostEnabled } from "@/hooks/useClaudeCodeHostEnabled";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { cn } from "@/lib/utils";
import { SupportChip } from "./support-chip";
import { buildPresetCompareEntries } from "./host-compare-presets";
import {
  CANIUSE_LAST_VERIFIED_DATE,
  buildCaniuseCapabilityPath,
  getCaniuseCapabilityBySlug,
  getCaniuseSupportLabel,
  getCaniuseSupportLevel,
  sortCaniusePresetHosts,
} from "./caniuse-capability-catalog";

const INSPECTOR_CTA_URL = "https://app.mcpjam.com";
const FULL_MATRIX_PATH = "/embed/host-compare";

interface CaniuseCapabilityPageProps {
  capabilitySlug: string | null | undefined;
}

export function CaniuseCapabilityPage({
  capabilitySlug,
}: CaniuseCapabilityPageProps) {
  const capability = getCaniuseCapabilityBySlug(capabilitySlug);
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const claudeCodeEnabled = useClaudeCodeHostEnabled();
  const excludedPresetTemplateIds = useMemo(() => {
    const excluded = new Set<"claude-code">();
    if (!claudeCodeEnabled) excluded.add("claude-code");
    return excluded;
  }, [claudeCodeEnabled]);
  const presets = useMemo(
    () =>
      buildPresetCompareEntries(themeMode, {
        excludedTemplateIds: excludedPresetTemplateIds,
      }),
    [themeMode, excludedPresetTemplateIds],
  );
  const hosts = useMemo(
    () => sortCaniusePresetHosts(presets.hosts),
    [presets.hosts],
  );

  if (!capability) {
    return (
      <PageShell>
        <a
          href={FULL_MATRIX_PATH}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          Full matrix
        </a>
        <div className="mt-8 rounded-lg border border-border bg-card p-8">
          <h1 className="text-2xl font-semibold tracking-normal text-foreground">
            Capability not found
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            This capability permalink does not exist yet.
          </p>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <a
          href={FULL_MATRIX_PATH}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          Full matrix
        </a>
        <Button asChild size="sm" className="h-9">
          <a href={INSPECTOR_CTA_URL}>Verify against your server</a>
        </Button>
      </div>

      <header className="mt-8">
        <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          MCP client capability
        </div>
        <h1 className="mt-2 text-3xl font-semibold tracking-normal text-foreground sm:text-4xl">
          {capability.field.label}
        </h1>
        {capability.field.description ? (
          <p className="mt-3 max-w-3xl text-base leading-7 text-muted-foreground">
            {capability.field.description}
          </p>
        ) : null}
        <div className="mt-4 text-xs text-muted-foreground">
          Permalink:{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
            {buildCaniuseCapabilityPath(capability.slug)}
          </code>
        </div>
      </header>

      <section className="mt-8 overflow-hidden rounded-lg border border-border bg-card">
        <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(100px,0.7fr)_minmax(120px,0.8fr)] border-b border-border bg-muted/50 px-4 py-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          <div>Client</div>
          <div>Status</div>
          <div>Last verified</div>
        </div>
        <div className="divide-y divide-border">
          {hosts.map((host) => {
            const subject = presets.subjects[host.hostId];
            if (!subject) return null;
            const level = getCaniuseSupportLevel(
              capability.field,
              subject.config,
            );
            const label = getCaniuseSupportLabel(level);
            const logoSrc = getChatboxHostLogo(
              subject.hostStyle,
              subject.config.chatUiOverride,
              themeMode,
            );
            return (
              <div
                key={host.hostId}
                className="grid grid-cols-[minmax(0,1.5fr)_minmax(100px,0.7fr)_minmax(120px,0.8fr)] items-center gap-3 px-4 py-3 text-sm"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <img
                    src={logoSrc}
                    alt=""
                    className="size-4 shrink-0 object-contain"
                  />
                  <span className="truncate font-medium text-foreground">
                    {subject.hostName}
                  </span>
                </div>
                <div>
                  <SupportChip level={level} label={label} truncateLabel />
                </div>
                <div className="text-xs tabular-nums text-muted-foreground">
                  {CANIUSE_LAST_VERIFIED_DATE}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </PageShell>
  );
}

function PageShell({ children }: { children: ReactNode }) {
  return (
    <main
      className={cn(
        "min-h-[100dvh] bg-background px-4 py-5 text-foreground",
        "sm:px-6 sm:py-8",
      )}
    >
      <div className="mx-auto w-full max-w-5xl">{children}</div>
    </main>
  );
}
