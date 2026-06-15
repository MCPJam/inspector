import { Switch } from "@mcpjam/design-system/switch";
import type { HostConfigInputV2 } from "@/lib/client-config-v2";
import { FieldRow, FocusBlock } from "./primitives";
import { useBuiltInToolCatalog } from "@/hooks/useBuiltInToolCatalog";
import {
  attachComputerPatch,
  detachComputerPatch,
} from "@/lib/host-config-computer";

interface ComputerTabProps {
  draft: HostConfigInputV2;
  onDraftChange: (
    updater: (prev: HostConfigInputV2) => HostConfigInputV2,
  ) => void;
  /** Disable every control (read-only editor surfaces). */
  readOnly?: boolean;
}

/**
 * The host's personal-computer attachment as a dedicated focus tab — the
 * attach/detach toggle the canvas "Computer" island deep-links to. Flag-gated
 * (the tab itself is only surfaced when `computers-enabled` is on, or a
 * computer is already attached so it stays detachable — see
 * `visibleHostFocusTabs`).
 *
 * Attaching is the *resource*; computer-backed tools (e.g. Bash) are granted
 * separately in the Tools tab and ride this attachment. Detaching strips any
 * computer-backed tool ids so the backend's requiresComputer invariant holds
 * (see `detachComputerPatch`).
 */
export function ComputerTab({
  draft,
  onDraftChange,
  readOnly = false,
}: ComputerTabProps) {
  const builtInToolCatalog = useBuiltInToolCatalog();
  const update = (patch: Partial<HostConfigInputV2>) =>
    onDraftChange((prev) => ({ ...prev, ...patch }));

  return (
    <div className="flex flex-col gap-4">
      <FocusBlock title="Computer">
        <FieldRow
          label="Personal computer"
          description="Attach a per-member cloud workstation (a persistent Linux sandbox). Required by computer-backed tools like Bash, which you enable in the Tools tab."
          control={
            <Switch
              checked={draft.computer !== undefined}
              onCheckedChange={(checked) =>
                update(
                  checked
                    ? attachComputerPatch()
                    : detachComputerPatch(draft, builtInToolCatalog),
                )
              }
              aria-label="Personal computer"
              disabled={readOnly}
            />
          }
        />
      </FocusBlock>
    </div>
  );
}
