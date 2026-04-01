import { startTransition, useDeferredValue, useMemo, useState } from "react";
import { CreditCard, Layers3, List, Loader2, Plus, Search } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardInteractive } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { SandboxListItem } from "@/hooks/useSandboxes";
import {
  getSandboxHostLabel,
  getSandboxHostLogo,
} from "@/lib/sandbox-host-style";

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
          {getSandboxHostLabel(sandbox.hostStyle)}
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

// ---------------------------------------------------------------------------
// SandboxIndexPage
// ---------------------------------------------------------------------------

interface SandboxIndexPageProps {
  sandboxes: SandboxListItem[] | undefined;
  isLoading: boolean;
  onOpenSandbox: (sandboxId: string) => void;
  onCreateSandbox: () => void;
  isCreateSandboxDisabled?: boolean;
  isCreateSandboxLoading?: boolean;
  createSandboxUpsell?: {
    title: string;
    message: string;
    teaser?: string | null;
    canManageBilling: boolean;
    ctaLabel: string;
    onNavigateToBilling: () => void;
  } | null;
}

export function SandboxIndexPage({
  sandboxes,
  isLoading,
  onOpenSandbox,
  onCreateSandbox,
  isCreateSandboxDisabled = false,
  isCreateSandboxLoading = false,
  createSandboxUpsell = null,
}: SandboxIndexPageProps) {
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"architecture" | "list">(
    "architecture",
  );
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
            onClick={onCreateSandbox}
            disabled={isCreateSandboxDisabled || isCreateSandboxLoading}
          >
            <Plus className="size-4" />
            New sandbox
          </Button>
        </div>

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
              variant={viewMode === "architecture" ? "secondary" : "ghost"}
              size="sm"
              className="rounded-lg"
              onClick={() => setViewMode("architecture")}
            >
              <Layers3 className="mr-1.5 size-4" />
              Architecture
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

        {createSandboxUpsell ? (
          <Alert
            className="mt-4 border-primary/20 bg-primary/[0.04]"
            data-testid="sandbox-limit-upsell"
          >
            <CreditCard className="size-4 text-primary" />
            <AlertTitle>{createSandboxUpsell.title}</AlertTitle>
            <AlertDescription className="gap-3">
              <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                <div className="space-y-1">
                  <p>{createSandboxUpsell.message}</p>
                  {createSandboxUpsell.teaser ? (
                    <p className="text-foreground/80">
                      {createSandboxUpsell.teaser}
                    </p>
                  ) : null}
                  {!createSandboxUpsell.canManageBilling ? (
                    <p className="font-medium text-foreground/80">
                      Ask an organization owner to review billing options.
                    </p>
                  ) : null}
                </div>
                {createSandboxUpsell.canManageBilling ? (
                  <Button
                    type="button"
                    size="sm"
                    className="md:self-end"
                    onClick={createSandboxUpsell.onNavigateToBilling}
                  >
                    {createSandboxUpsell.ctaLabel}
                  </Button>
                ) : null}
              </div>
            </AlertDescription>
          </Alert>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : filteredSandboxes.length === 0 ? (
          <Card className="flex min-h-[320px] flex-col items-center justify-center rounded-[28px] border-dashed text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl border border-border/60 bg-muted/30">
              <Search className="size-5 text-muted-foreground" />
            </div>
            <h3 className="mt-5 text-xl font-semibold">No sandboxes found</h3>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              Create a new sandbox or broaden the current search.
            </p>
            <Button
              className="mt-5 rounded-xl"
              onClick={onCreateSandbox}
              disabled={isCreateSandboxDisabled || isCreateSandboxLoading}
            >
              <Plus className="mr-1.5 size-4" />
              Create sandbox
            </Button>
          </Card>
        ) : viewMode === "architecture" ? (
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
                  <Badge variant="outline">{sandbox.hostStyle}</Badge>
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
