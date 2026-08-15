import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { RequiredMark } from "@/components/shared/required-mark";
import { useProjectServers } from "@/hooks/useViews";
import { useClaudeCodeHostEnabled } from "@/hooks/useClaudeCodeHostEnabled";
import { useCodexHostEnabled } from "@/hooks/useCodexHostEnabled";
import { useHostCatalog } from "@/lib/host-compat/use-host-catalog";
import { filterHostsByFeatureFlags } from "@/lib/host-compat/feature-visibility";
import {
  getCatalogHost,
  getCatalogHosts,
  getCatalogTemplate,
} from "@mcpjam/sdk/host-compat";
import {
  DEFAULT_CATALOG_HOST_ID,
  getHostLogoSrc,
} from "@/lib/host-ui-metadata";
import {
  cloneHostTemplateInput,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import {
  CHATBOX_ACCESS_OPTIONS as ACCESS_OPTIONS,
  settingsFromChatboxAccessPreset,
  type ChatboxAccessPreset,
} from "@/lib/chatbox-access-presets";
import type { ChatboxMode } from "@/hooks/useChatboxes";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * `/user-testing/new` — create a scenario: pick the server, pick the client the
 * tester will see, decide who can open it, save.
 *
 * **Nothing is written until Save.** Every choice is local state; the single
 * write is `onCreateScenario`, injected by the parent (the same inversion
 * `new-swarm-create-flow` uses). This matters more than it looks: the version
 * of this screen we replaced minted a draft host on mount, so every abandoned
 * visit left an orphaned host and chatbox in the project, and they showed up in
 * the list as real scenarios.
 *
 * There is no preview pane for the same reason — before Save there is nothing
 * to preview.
 */
interface UserTestingCreateFlowProps {
  projectId: string;
  isAuthenticated: boolean;
  onCancel: () => void;
  /**
   * The ONLY write path. Creates the client, the ad-hoc environment over it,
   * the chatbox and the access mode in one mutation; resolves to the new
   * scenario's CHATBOX id, which is what the scenario route is keyed on.
   */
  onCreateScenario: (draft: {
    name: string;
    input: HostConfigInputV2;
    chatboxMode: ChatboxMode;
  }) => Promise<{ chatboxId: string }>;
}


export function UserTestingCreateFlow({
  projectId,
  isAuthenticated,
  onCancel,
  onCreateScenario,
}: UserTestingCreateFlowProps) {
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const catalogState = useHostCatalog();
  const claudeCodeEnabled = useClaudeCodeHostEnabled();
  const codexEnabled = useCodexHostEnabled();
  const { servers } = useProjectServers({ isAuthenticated, projectId });

  const visibleCatalogHosts = useMemo(
    () =>
      catalogState.status === "live"
        ? filterHostsByFeatureFlags(getCatalogHosts(catalogState.catalog), {
            claudeCode: claudeCodeEnabled,
            codex: codexEnabled,
          }).sort((a, b) => a.label.localeCompare(b.label))
        : [],
    [catalogState, claudeCodeEnabled, codexEnabled],
  );
  const defaultTemplateId =
    visibleCatalogHosts.find((h) => h.id === DEFAULT_CATALOG_HOST_ID)?.id ??
    visibleCatalogHosts[0]?.id ??
    DEFAULT_CATALOG_HOST_ID;

  const [name, setName] = useState("");
  // Set once the user hand-types a name, so the template-label default below
  // stops overwriting it. A ref rather than state derived inside the setter:
  // mutating during an updater is impure and StrictMode's double-invoke made
  // the older version of that trick misread a defaulted name as user-typed.
  const userEditedNameRef = useRef(false);
  const [templateId, setTemplateId] = useState(defaultTemplateId);
  const [serverId, setServerId] = useState<string | null>(null);
  const [accessPreset, setAccessPreset] =
    useState<ChatboxAccessPreset>("invited_only");
  const [isSaving, setIsSaving] = useState(false);
  // Synchronous guard: a double-click must not create two scenarios before
  // React commits `isSaving`.
  const savingRef = useRef(false);

  const templateLabel =
    catalogState.status === "live"
      ? getCatalogHost(catalogState.catalog, templateId)?.label ?? ""
      : "";
  const templateInput =
    catalogState.status === "live"
      ? getCatalogTemplate(catalogState.catalog, templateId)
      : undefined;

  // Keep the selection inside the visible set — a flag can hide the client
  // that was picked.
  useEffect(() => {
    if (visibleCatalogHosts.length === 0) return;
    if (!visibleCatalogHosts.some((h) => h.id === templateId)) {
      setTemplateId(defaultTemplateId);
    }
  }, [visibleCatalogHosts, templateId, defaultTemplateId]);

  useEffect(() => {
    if (userEditedNameRef.current) return;
    setName(templateLabel);
  }, [templateLabel]);

  useEffect(() => {
    if (serverId) return;
    if (servers && servers.length > 0) setServerId(servers[0]._id);
  }, [servers, serverId]);

  const selectedServer = servers?.find((s) => s._id === serverId);
  const canSave =
    Boolean(name.trim()) && Boolean(templateInput) && !isSaving && !!projectId;

  const handleSave = async () => {
    if (!canSave || !templateInput || savingRef.current) return;
    savingRef.current = true;
    setIsSaving(true);
    try {
      const seed = cloneHostTemplateInput(templateInput, { themeMode });
      await onCreateScenario({
        name: name.trim(),
        input: { ...seed, serverIds: serverId ? [serverId] : [] },
        chatboxMode: settingsFromChatboxAccessPreset(accessPreset)
          .mode as ChatboxMode,
      });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to create the scenario",
      );
      savingRef.current = false;
      setIsSaving(false);
    }
    // On success the parent navigates away; leaving the latch set keeps the
    // button inert through the unmount.
  };

  const catalogUnavailable =
    catalogState.status !== "live"
      ? catalogState.status === "loading"
        ? "Loading client templates…"
        : "Could not load client templates. Try again in a moment."
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border/40 px-6 py-4 sm:px-8">
        <button
          type="button"
          onClick={onCancel}
          data-testid="user-testing-create-back"
          className={cn(
            "inline-flex items-center gap-1 rounded-sm text-sm font-medium text-primary",
            "hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <ArrowLeft className="size-3.5" />
          User Testing
        </button>
        <h1 className="mt-2 text-xl font-semibold tracking-tight">
          New scenario
        </h1>
        <p className="mt-1 max-w-xl text-sm text-muted-foreground">
          One of your servers, seen through the client a tester already uses.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8">
        <div className="mx-auto flex max-w-xl flex-col gap-6">
          <div className="space-y-2">
            {/* Marked because Save is gated on them — the name and the client
                are what this flow cannot mint a scenario without. The server is
                deliberately unmarked: it is optional here, and pretending
                otherwise would mark a field the button doesn't wait for. */}
            <Label htmlFor="scenario-name">
              Scenario name
              <RequiredMark />
            </Label>
            <Input
              id="scenario-name"
              aria-required
              value={name}
              onChange={(e) => {
                userEditedNameRef.current = e.target.value.trim().length > 0;
                setName(e.target.value);
              }}
              placeholder="e.g. Payments API public beta"
            />
          </div>

          <div className="space-y-2">
            <Label>Server</Label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-testid="user-testing-create-server"
                  className="flex w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  <span className="flex-1 truncate text-left">
                    {selectedServer
                      ? selectedServer.name
                      : servers === undefined
                      ? "Loading servers…"
                      : "No server"}
                  </span>
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-[--radix-dropdown-menu-trigger-width]"
              >
                <DropdownMenuRadioGroup
                  value={serverId ?? ""}
                  onValueChange={setServerId}
                >
                  {(servers ?? []).map((s) => (
                    <DropdownMenuRadioItem key={s._id} value={s._id}>
                      {s.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {servers && servers.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Connect a server first — a scenario with nothing attached gives
                a tester nothing to try.
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label>
              Client the tester will see
              <RequiredMark />
            </Label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-testid="user-testing-create-client"
                  className="flex w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  <img
                    src={getHostLogoSrc(templateId, themeMode)}
                    alt=""
                    className="size-4 shrink-0 object-contain"
                  />
                  <span className="flex-1 truncate text-left">
                    {templateLabel || "Select a client"}
                  </span>
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-[--radix-dropdown-menu-trigger-width]"
              >
                <DropdownMenuRadioGroup
                  value={templateId}
                  onValueChange={setTemplateId}
                >
                  {visibleCatalogHosts.map((h) => (
                    <DropdownMenuRadioItem
                      key={h.id}
                      value={h.id}
                      className="gap-2"
                    >
                      <img
                        src={getHostLogoSrc(h.id, themeMode)}
                        alt=""
                        className="size-4 object-contain"
                      />
                      {h.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {catalogUnavailable ? (
              <p className="text-xs text-muted-foreground">
                {catalogUnavailable}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label>Who can open it</Label>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-testid="user-testing-create-access"
                  className="flex w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                >
                  <span className="flex-1 truncate text-left">
                    {
                      ACCESS_OPTIONS.find((o) => o.value === accessPreset)
                        ?.label
                    }
                  </span>
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-[--radix-dropdown-menu-trigger-width]"
              >
                <DropdownMenuRadioGroup
                  value={accessPreset}
                  onValueChange={(v) =>
                    setAccessPreset(v as ChatboxAccessPreset)
                  }
                >
                  {ACCESS_OPTIONS.map((option) => (
                    <DropdownMenuRadioItem
                      key={option.value}
                      value={option.value}
                      className="items-start"
                    >
                      <div>
                        <div className="font-medium">{option.label}</div>
                        <p className="text-xs font-normal text-muted-foreground">
                          {option.description}
                        </p>
                      </div>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border/40 pt-5">
            <Button variant="ghost" onClick={onCancel} disabled={isSaving}>
              Cancel
            </Button>
            <Button
              data-testid="user-testing-create-save"
              disabled={!canSave}
              onClick={() => void handleSave()}
            >
              {isSaving ? (
                <Loader2 className="mr-1.5 size-4 animate-spin" />
              ) : null}
              Create scenario
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
