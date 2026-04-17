import { startTransition, useDeferredValue, useMemo, useState } from "react";
import {
  CreditCard,
  Building2,
  Globe,
  Info,
  LayoutGrid,
  List,
  Loader2,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Alert, AlertDescription, AlertTitle } from "@mcpjam/design-system/alert";
import { Button } from "@mcpjam/design-system/button";
import { Badge } from "@mcpjam/design-system/badge";
import { Card, CardInteractive } from "@mcpjam/design-system/card";
import { Input } from "@mcpjam/design-system/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import type { SandboxListItem } from "@/hooks/useSandboxes";
import {
  getSandboxHostLogo,
  getSandboxHostStyleShortLabel,
} from "@/lib/sandbox-host-style";
import { SandboxDeleteConfirmDialog } from "@/components/sandboxes/SandboxDeleteConfirmDialog";
import { SandboxIndexRowActionsMenu } from "./sandbox-index-row-actions";
import { SANDBOX_BLANK_STARTER, SANDBOX_TEMPLATE_STARTERS } from "./drafts";
import type { SandboxStarterDefinition } from "./types";

export type SandboxOpenOptions = {
  initialViewMode?: "setup" | "preview" | "usage";
};

// ---------------------------------------------------------------------------
// SandboxSummaryCard — info-first layout
// ---------------------------------------------------------------------------

function SandboxSummaryCard({
  sandbox,
  onOpen,
  onEdit,
  onUsage,
  onDuplicate,
  onDelete,
  isDeleting,
  isDuplicating,
}: {
  sandbox: SandboxListItem;
  onOpen: () => void;
  onEdit: () => void;
  onUsage: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  isDeleting: boolean;
  isDuplicating: boolean;
}) {
  const modeLabel =
    sandbox.mode === "invited_only" ? "Invited only" : "Anyone with link";

  const serverList =
    sandbox.serverNames.length > 0
      ? sandbox.serverNames.join(" · ")
      : "No servers configured";

  return (
    <CardInteractive className="flex flex-col gap-4" onClick={onOpen}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 truncate text-lg font-bold tracking-tight">
          {sandbox.name}
        </h3>
        <SandboxIndexRowActionsMenu
          sandbox={sandbox}
          onEdit={onEdit}
          onUsage={onUsage}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
          isDeleting={isDeleting}
          isDuplicating={isDuplicating}
        />
      </div>

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
  "internal-qa": Building2,
  "icp-demo": Globe,
} as const;

function FirstRunTemplateTile({
  starter,
  onSelectStarter,
}: {
  starter: SandboxStarterDefinition;
  onSelectStarter: (starter: SandboxStarterDefinition) => void;
}) {
  const Icon = STARTER_ICONS[starter.id] ?? Sparkles;
  const tooltip = starter.templateTooltip;

  const tileInner = (
    <>
      <span className="inline-flex size-11 items-center justify-center rounded-2xl border border-border/60 bg-muted/35 transition-colors duration-200 group-hover:border-primary/35 group-hover:bg-primary/10">
        <Icon className="size-5 text-muted-foreground transition-colors duration-200 group-hover:text-primary" />
      </span>
      <span className="mt-4 font-semibold leading-snug transition-colors group-hover:text-foreground">
        {starter.title}
      </span>
      <span className="mt-2 line-clamp-3 text-sm text-muted-foreground">
        {starter.description}
      </span>
    </>
  );

  if (!tooltip) {
    return (
      <button
        type="button"
        onClick={() => onSelectStarter(starter)}
        className="group flex flex-col rounded-[28px] border border-border/70 bg-card/70 p-5 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/45 hover:bg-primary/5 hover:shadow-lg"
      >
        {tileInner}
      </button>
    );
  }

  return (
    <div className="group relative rounded-[28px] border border-border/70 bg-card/70 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/45 hover:bg-primary/5 hover:shadow-lg">
      <button
        type="button"
        onClick={() => onSelectStarter(starter)}
        className="flex w-full flex-col rounded-[28px] p-5 pr-12 text-left"
      >
        {tileInner}
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="absolute top-3 right-3 z-10 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="What this template includes"
            onClick={(e) => e.stopPropagation()}
          >
            <Info className="size-4" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="left"
          sideOffset={6}
          className="max-w-[220px] px-2.5 py-1.5 text-left text-xs leading-snug text-balance"
        >
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SandboxIndexPage
// ---------------------------------------------------------------------------

interface SandboxIndexPageProps {
  sandboxes: SandboxListItem[] | undefined;
  isLoading: boolean;
  onOpenSandbox: (sandboxId: string, options?: SandboxOpenOptions) => void;
  onDuplicateSandbox: (sandbox: SandboxListItem) => void;
  onDeleteSandbox: (sandbox: SandboxListItem) => void;
  /** Sandbox id currently being deleted (disables that row’s delete control). */
  deletingSandboxId?: string | null;
  /** Sandbox id currently being duplicated. */
  duplicatingSandboxId?: string | null;
  /** Opens the starter chooser (e.g. Command dialog). */
  onOpenStarterLauncher: () => void;
  /** Creates a builder draft from a starter (inline tiles or launcher). */
  onSelectStarter: (starter: SandboxStarterDefinition) => void;
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
  onDuplicateSandbox,
  onDeleteSandbox,
  deletingSandboxId = null,
  duplicatingSandboxId = null,
  onOpenStarterLauncher,
  onSelectStarter,
  isCreateSandboxDisabled = false,
  isCreateSandboxLoading = false,
  createSandboxUpsell = null,
}: SandboxIndexPageProps) {
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"cards" | "list">("cards");
  const [pendingDelete, setPendingDelete] = useState<SandboxListItem | null>(
    null,
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

  const totalCount = sandboxes?.length ?? 0;
  const isFirstRunEmpty =
    !isLoading && totalCount === 0 && deferredQuery.trim() === "";
  const isSearchEmpty =
    !isLoading && totalCount > 0 && filteredSandboxes.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SandboxDeleteConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        sandboxName={pendingDelete?.name ?? ""}
        isDeleting={
          !!pendingDelete && deletingSandboxId === pendingDelete.sandboxId
        }
        onConfirm={async () => {
          if (!pendingDelete) return;
          await onDeleteSandbox(pendingDelete);
        }}
      />
      <div className="border-b px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="mt-2 text-3xl font-semibold">Sandboxes</h2>
          </div>
          <Button
            size="lg"
            className="gap-2 rounded-xl"
            onClick={onOpenStarterLauncher}
            disabled={isCreateSandboxDisabled || isCreateSandboxLoading}
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
        ) : isFirstRunEmpty ? (
          <div className="mx-auto flex max-w-3xl flex-col gap-8">
            <div>
              <h3 className="text-2xl font-semibold tracking-tight">
                Create your first sandbox
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Templates include defaults for common flows—usually the fastest
                way to get started. Prefer an empty builder? Use Create New
                under the templates. You can change everything before saving.
              </p>
            </div>

            <div className="flex flex-col gap-4">
              <h4 className="text-sm font-semibold text-foreground">
                Recommended templates
              </h4>
              <div className="grid gap-4 sm:grid-cols-1 md:grid-cols-2">
                {SANDBOX_TEMPLATE_STARTERS.map((starter) => (
                  <FirstRunTemplateTile
                    key={starter.id}
                    starter={starter}
                    onSelectStarter={onSelectStarter}
                  />
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-medium text-muted-foreground">
                Or start from scratch
              </h4>
              <div className="w-full max-w-md">
                <button
                  type="button"
                  onClick={() => onSelectStarter(SANDBOX_BLANK_STARTER)}
                  className="flex w-full flex-col gap-3 rounded-2xl border border-border/70 bg-card/70 p-5 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:bg-card hover:shadow-md"
                >
                  <span className="inline-flex size-11 items-center justify-center rounded-2xl border border-border/60 bg-muted/35">
                    <Plus
                      className="size-5 text-muted-foreground"
                      aria-hidden
                    />
                  </span>
                  <span className="text-base font-semibold leading-snug text-foreground">
                    Create New
                  </span>
                  <span className="line-clamp-3 text-sm text-muted-foreground">
                    {SANDBOX_BLANK_STARTER.description}
                  </span>
                </button>
              </div>
            </div>

            <div className="flex pb-4">
              <Button
                variant="outline"
                size="lg"
                className="rounded-xl"
                onClick={onOpenStarterLauncher}
              >
                Browse all starters
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
                onEdit={() => onOpenSandbox(sandbox.sandboxId)}
                onUsage={() =>
                  onOpenSandbox(sandbox.sandboxId, {
                    initialViewMode: "usage",
                  })
                }
                onDuplicate={() => onDuplicateSandbox(sandbox)}
                onDelete={() => setPendingDelete(sandbox)}
                isDeleting={deletingSandboxId === sandbox.sandboxId}
                isDuplicating={duplicatingSandboxId === sandbox.sandboxId}
              />
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {filteredSandboxes.map((sandbox) => (
              <div
                key={sandbox.sandboxId}
                className="flex w-full items-stretch gap-1 rounded-2xl border border-border/70 bg-card/70 transition-colors hover:border-primary/40 hover:bg-card"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center justify-between px-4 py-4 text-left"
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
                    <Badge variant="outline">
                      {sandbox.serverCount} servers
                    </Badge>
                  </div>
                </button>
                <div className="flex shrink-0 items-center pr-2">
                  <SandboxIndexRowActionsMenu
                    triggerClassName="text-muted-foreground shrink-0"
                    sandbox={sandbox}
                    onEdit={() => onOpenSandbox(sandbox.sandboxId)}
                    onUsage={() =>
                      onOpenSandbox(sandbox.sandboxId, {
                        initialViewMode: "usage",
                      })
                    }
                    onDuplicate={() => onDuplicateSandbox(sandbox)}
                    onDelete={() => setPendingDelete(sandbox)}
                    isDeleting={deletingSandboxId === sandbox.sandboxId}
                    isDuplicating={duplicatingSandboxId === sandbox.sandboxId}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
