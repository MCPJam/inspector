import type { HostConfigInputV2 } from "@/lib/client-config-v2";
import { FocusBlock } from "./primitives";
import { useBuiltInToolCatalog } from "@/hooks/useBuiltInToolCatalog";
import { BuiltInToolCheckboxList } from "@/components/client-config/BuiltInToolCheckboxList";
import { visibleBuiltInToolCatalog } from "@/lib/host-config-computer";
import { useComputersEnabled } from "@/hooks/useComputersEnabled";
import { useHarnessBuiltinToolCatalog } from "@/hooks/useHarnessBuiltinTools";

interface ToolsTabProps {
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2,
  ) => void;
  /** Disable every control (read-only editor surfaces). */
  readOnly?: boolean;
}

/**
 * Host-managed built-in tools (Web Search, Bash, …) as a dedicated focus
 * tab. Previously lived inline in BehaviorTab; promoted to its own tab so
 * the canvas "Built-in tools" island can deep-link straight to it.
 *
 * The personal-computer attach/detach toggle that gates computer-backed
 * tools lives in the sibling ComputerTab — this tab only edits the tool
 * selection. A computer-backed row (e.g. `bash`) renders blocked here until
 * the computer is attached over there (BuiltInToolCheckboxList copy points
 * to the Computer tab).
 */
export function ToolsTab({
  draft,
  onDraftChange,
  readOnly = false,
}: ToolsTabProps) {
  const builtInToolCatalog = useBuiltInToolCatalog();
  const computersEnabled = useComputersEnabled();
  // Render only the rows this user may see: with `computers-enabled` off,
  // computer-backed rows (e.g. an enabled `bash`) stay hidden — except an
  // already-selected id, which must remain visible to stay removable.
  const visibleBuiltInTools = visibleBuiltInToolCatalog(builtInToolCatalog, {
    computersEnabled,
    selectedIds: draft.builtInToolIds,
  });

  const update = (patch: Partial<HostConfigInputV2>) =>
    onDraftChange((prev) => ({ ...prev, ...patch }));

  // For a harness host (e.g. Claude Code), show the agent's NATIVE built-in
  // tools (Bash, Read, Edit, …) — read-only: they're intrinsic to the runtime
  // and run in its sandbox, so they aren't toggled here.
  const { tools: harnessTools, loading: harnessLoading } =
    useHarnessBuiltinToolCatalog(draft.harness ?? null);

  return (
    <div className="flex flex-col gap-4">
      <FocusBlock
        title="System tools"
        subtitle="First-party capabilities beyond MCP servers."
      >
        <BuiltInToolCheckboxList
          variant="minimal"
          selected={draft.builtInToolIds}
          available={visibleBuiltInTools ?? []}
          computerAttached={draft.computer !== undefined}
          computerAttachHint="attach it in the Computer tab"
          readOnly={readOnly}
          onChange={(builtInToolIds) => update({ builtInToolIds })}
        />
      </FocusBlock>

      {draft.harness && (
        <FocusBlock
          title="Built-in agent tools"
          subtitle="Native tools the agent runs in its sandbox. Always available; not configurable here."
        >
          {harnessLoading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : harnessTools.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No built-in tools reported.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {harnessTools.map((tool) => (
                <li key={tool.key}>
                  <div className="flex items-center gap-1.5">
                    <code className="text-xs font-mono font-medium">
                      {tool.name}
                    </code>
                    {tool.toolUseKind && (
                      <span className="font-mono text-[9px] rounded bg-accent px-1 py-[1px] text-accent-foreground">
                        {tool.toolUseKind}
                      </span>
                    )}
                  </div>
                  {tool.description && (
                    <p className="text-[11px] leading-snug text-muted-foreground">
                      {tool.description}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </FocusBlock>
      )}
    </div>
  );
}
