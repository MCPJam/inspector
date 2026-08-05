import { useMemo } from "react";
import { Badge } from "@mcpjam/design-system/badge";
import { Switch } from "@mcpjam/design-system/switch";
import { SettingsSection } from "@/components/setting/SettingsSection";
import { useAgentOpCatalog } from "@/hooks/useAgentOpCatalog";
import {
  useOrgSlackCapabilities,
  type AgentOpCatalogEntry,
} from "@/hooks/useOrgSlackSettings";

/**
 * Capabilities: which agent operations this org allows.
 *
 * DISABLE-ONLY, and the UI says so rather than implying otherwise. The
 * server's registry is the floor: a toggle can take an operation away, never
 * add one, and never turn a direct operation into one that needs approval.
 * That is why the gated group carries a read-only "Requires approval" badge
 * instead of a promotion control — promotion is a real feature (it needs
 * per-request entry lists and authored approval copy for ~20 operations), and
 * a control that looked like it did that would be a lie.
 *
 * The op list is FETCHED from the server so it cannot drift from the registry.
 */

const GROUPS = [
  {
    id: "read",
    title: "Read",
    description:
      "Inspecting the project. These spend nothing and change nothing.",
    match: (op: AgentOpCatalogEntry) => op.tier === "direct" && op.readOnly,
  },
  {
    id: "write",
    title: "Write",
    description: "Persists to the project, but spends nothing.",
    match: (op: AgentOpCatalogEntry) => op.tier === "direct" && !op.readOnly,
  },
  {
    id: "gated",
    title: "Requires approval",
    description:
      "Spends quota or reaches outside MCPJam. The agent can only propose these; a person clicks to run them.",
    match: (op: AgentOpCatalogEntry) => op.tier === "gated",
  },
] as const;

interface SlackCapabilitiesTabProps {
  organizationId: string;
  isAdmin: boolean;
}

export function SlackCapabilitiesTab({
  organizationId,
  isAdmin,
}: SlackCapabilitiesTabProps) {
  const {
    operations,
    isLoading: catalogLoading,
    error: catalogError,
  } = useAgentOpCatalog();
  const {
    disabledOperations,
    isLoading: policyLoading,
    error: policyError,
    isSaving,
    setDisabledOperations,
  } = useOrgSlackCapabilities(organizationId);

  const disabled = useMemo(
    () => new Set(disabledOperations ?? []),
    [disabledOperations]
  );

  const grouped = useMemo(() => {
    if (!operations) return [];
    return GROUPS.map((group) => ({
      ...group,
      operations: operations.filter((op) => group.match(op)),
    })).filter((group) => group.operations.length > 0);
  }, [operations]);

  const toggle = async (name: string, nextEnabled: boolean) => {
    const next = new Set(disabled);
    if (nextEnabled) next.delete(name);
    else next.add(name);
    // Whole-list replacement, matching the mutation. The page renders every
    // operation, so what the admin is expressing IS the complete state.
    await setDisabledOperations([...next].sort()).catch(() => {});
  };

  const isLoading = catalogLoading || policyLoading;
  const error = catalogError ?? policyError;

  return (
    <div className="space-y-8">
      {error ? (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          {catalogError
            ? "Could not load the agent's tool list. Try again in a moment."
            : error}
        </p>
      ) : null}

      <p className="text-sm text-muted-foreground">
        Disabled tools are removed from the agent and rejected at execution.
        Changes take effect within a minute.
      </p>

      {isLoading && grouped.length === 0 ? (
        <div className="px-4 py-8 text-sm text-muted-foreground">Loading…</div>
      ) : (
        grouped.map((group) => (
          <SettingsSection key={group.id} title={group.title}>
            <p className="px-4 pb-1 text-xs text-muted-foreground">
              {group.description}
            </p>
            {group.operations.map((operation) => {
              const isEnabled = !disabled.has(operation.name);
              return (
                <div
                  key={operation.name}
                  className="flex items-start justify-between gap-4 rounded-md border border-border/40 px-4 py-3"
                  data-testid={`agent-op-${operation.name}`}
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs">
                        {operation.name}
                      </span>
                      {operation.tier === "gated" ? (
                        <Badge variant="secondary">Requires approval</Badge>
                      ) : null}
                      {operation.confirmSeverity === "external" ? (
                        <Badge variant="destructive">
                          Runs third-party code
                        </Badge>
                      ) : null}
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {operation.description}
                    </span>
                  </div>
                  <Switch
                    checked={isEnabled}
                    disabled={!isAdmin || isSaving}
                    aria-label={`Enable ${operation.name}`}
                    onCheckedChange={(next) =>
                      void toggle(operation.name, next === true)
                    }
                  />
                </div>
              );
            })}
          </SettingsSection>
        ))
      )}

      {!isAdmin ? (
        <p className="text-xs text-muted-foreground">
          Only organization admins can change these.
        </p>
      ) : null}
    </div>
  );
}
