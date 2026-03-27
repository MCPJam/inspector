import { startTransition, useDeferredValue, useMemo, useState } from "react";
import {
  LayoutGrid,
  List,
  Loader2,
  Plus,
  Search,
  Sparkles,
  Users,
  Wand2,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardInteractive } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { SandboxListItem } from "@/hooks/useSandboxes";
import {
  getSandboxHostLogo,
  getSandboxHostStyleShortLabel,
} from "@/lib/sandbox-host-style";
import { SANDBOX_STARTERS } from "./drafts";
import type { SandboxStarterDefinition } from "./types";

// ---------------------------------------------------------------------------
// SandboxSummaryCard — info-first layout
// ---------------------------------------------------------------------------

function SandboxSummaryCard({
  sandbox,
  onOpen,
}: {
  sandbox: SandboxListItem;
  onOpen: () => void;
}) {
  const modeLabel =
    sandbox.mode === "invited_only" ? "Invited only" : "Anyone with link";

  const serverList =
    sandbox.serverNames.length > 0
      ? sandbox.serverNames.join(" · ")
      : "No servers configured";

  return (
    <CardInteractive className="flex flex-col gap-4" onClick={onOpen}>
      <h3 className="truncate text-lg font-bold tracking-tight">
        {sandbox.name}
      </h3>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge
          variant="secondary"
          className="gap-1.5 border-0 bg-muted/50 px-2 py-0 text-xs font-normal text-muted-foreground"
        >
          <img
            src={getSandboxHostLogo(sandbox.hostStyle)}
            alt=""
            className="size-3"
          />
          {getSandboxHostStyleShortLabel(sandbox.hostStyle)}
        </Badge>
        <Badge
          variant="secondary"
          className="border-0 bg-muted/50 px-2 py-0 text-xs font-normal text-muted-foreground"
        >
          {modeLabel}
        </Badge>
      </div>

      <p className="truncate text-sm text-muted-foreground">{serverList}</p>

      <p className="text-xs text-muted-foreground">
        Updated {formatDistanceToNow(sandbox.updatedAt, { addSuffix: true })}
      </p>
    </CardInteractive>
  );
}

const STARTER_ICONS = {
  "internal-qa": Users,
  "icp-demo": Sparkles,
  blank: Wand2,
} as const;

// ---------------------------------------------------------------------------
// SandboxIndexPage
// ---------------------------------------------------------------------------

interface SandboxIndexPageProps {
  sandboxes: SandboxListItem[] | undefined;
  isLoading: boolean;
  onOpenSandbox: (sandboxId: string) => void;
  /** Opens the starter chooser (e.g. Command dialog). */
  onOpenStarterLauncher: () => void;
  /** Creates a builder draft from a starter (inline tiles or launcher). */
  onSelectStarter: (starter: SandboxStarterDefinition) => void;
}

export function SandboxIndexPage({
  sandboxes,
  isLoading,
  onOpenSandbox,
  onOpenStarterLauncher,
  onSelectStarter,
}: SandboxIndexPageProps) {
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"cards" | "list">("cards");
  const deferredQuery = useDeferredValue(query);

  const filteredSandboxes = useMemo(() => {
    const normalized = deferredQuery.trim().toLowerCase();
    const base = [...(sandboxes ?? [])].filter((sandbox) => {
      if (!normalized) return true;
      return (
        sandbox.name.toLowerCase().includes(normalized) ||
        sandbox.description?.toLowerCase().includes(normalized) ||
        sandbox.serverNames.some((serverName) =>
          serverName.toLowerCase().includes(normalized),
        )
      );
    });

    base.sort((left, right) => right.updatedAt - left.updatedAt);

    return base;
  }, [deferredQuery, sandboxes]);

  const totalCount = sandboxes?.length ?? 0;
  const isFirstRunEmpty =
    !isLoading && totalCount === 0 && deferredQuery.trim() === "";
  const isSearchEmpty =
    !isLoading && totalCount > 0 && filteredSandboxes.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="mt-2 text-3xl font-semibold">Sandboxes</h2>
          </div>
          <Button
            size="lg"
            className="gap-2 rounded-xl"
            onClick={onOpenStarterLauncher}
          >
            <Plus className="size-4" />
            New sandbox
          </Button>
        </div>

        {!isFirstRunEmpty ? (
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <div className="relative min-w-[260px] flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  startTransition(() => setQuery(nextValue));
                }}
                placeholder="Search sandboxes, servers, or descriptions"
                className="pl-9"
              />
            </div>

            <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-card/60 p-1">
              <Button
                variant={viewMode === "cards" ? "secondary" : "ghost"}
                size="sm"
                className="rounded-lg"
                onClick={() => setViewMode("cards")}
              >
                <LayoutGrid className="mr-1.5 size-4" />
                Cards
              </Button>
              <Button
                variant={viewMode === "list" ? "secondary" : "ghost"}
                size="sm"
                className="rounded-lg"
                onClick={() => setViewMode("list")}
              >
                <List className="mr-1.5 size-4" />
                List
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : isFirstRunEmpty ? (
          <div className="mx-auto flex max-w-3xl flex-col gap-8">
            <div>
              <h3 className="text-2xl font-semibold tracking-tight">
                Create your first sandbox
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Pick a starter to open the builder with realistic defaults, or
                start blank. You can change everything before saving.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-1 md:grid-cols-3">
              {SANDBOX_STARTERS.map((starter) => {
                const Icon = STARTER_ICONS[starter.id] ?? Sparkles;
                return (
                  <button
                    key={starter.id}
                    type="button"
                    onClick={() => onSelectStarter(starter)}
                    className="flex flex-col rounded-[28px] border border-border/70 bg-card/70 p-5 text-left shadow-sm transition-colors hover:border-primary/35 hover:bg-card"
                  >
                    <span className="inline-flex size-11 items-center justify-center rounded-2xl border border-border/60 bg-muted/35">
                      <Icon className="size-5 text-muted-foreground" />
                    </span>
                    <span className="mt-4 font-semibold leading-snug">
                      {starter.title}
                    </span>
                    <span className="mt-2 line-clamp-3 text-sm text-muted-foreground">
                      {starter.description}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="flex justify-center pb-4">
              <Button
                variant="outline"
                size="lg"
                className="rounded-xl"
                onClick={onOpenStarterLauncher}
              >
                <Plus className="mr-2 size-4" />
                More options
              </Button>
            </div>
          </div>
        ) : isSearchEmpty ? (
          <Card className="flex min-h-[320px] flex-col items-center justify-center rounded-[28px] border-dashed text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl border border-border/60 bg-muted/30">
              <Search className="size-5 text-muted-foreground" />
            </div>
            <h3 className="mt-5 text-xl font-semibold">
              No matching sandboxes
            </h3>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              Try a different search, or clear the filter to see all sandboxes.
            </p>
            <Button
              variant="outline"
              className="mt-5 rounded-xl"
              onClick={() => setQuery("")}
            >
              Clear search
            </Button>
          </Card>
        ) : viewMode === "cards" ? (
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            {filteredSandboxes.map((sandbox) => (
              <SandboxSummaryCard
                key={sandbox.sandboxId}
                sandbox={sandbox}
                onOpen={() => onOpenSandbox(sandbox.sandboxId)}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {filteredSandboxes.map((sandbox) => (
              <button
                key={sandbox.sandboxId}
                type="button"
                className="flex w-full items-center justify-between rounded-2xl border border-border/70 bg-card/70 px-4 py-4 text-left transition-colors hover:border-primary/40 hover:bg-card"
                onClick={() => onOpenSandbox(sandbox.sandboxId)}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">
                    {sandbox.name}
                  </p>
                  <p className="mt-1 truncate text-sm text-muted-foreground">
                    {sandbox.description || "No description yet."}
                  </p>
                </div>
                <div className="ml-4 flex shrink-0 items-center gap-2">
                  <Badge variant="outline">
                    {getSandboxHostStyleShortLabel(sandbox.hostStyle)}
                  </Badge>
                  <Badge variant="outline">{sandbox.serverCount} servers</Badge>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
