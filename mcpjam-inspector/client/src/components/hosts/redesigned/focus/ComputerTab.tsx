import { useEffect, useState } from "react";
import { Switch } from "@mcpjam/design-system/switch";
import { Input } from "@mcpjam/design-system/input";
import type { HostConfigInputV2 } from "@/lib/client-config-v2";
import { FieldRow, FocusBlock } from "./primitives";
import { useBuiltInToolCatalog } from "@/hooks/useBuiltInToolCatalog";
import {
  attachComputerPatch,
  detachComputerPatch,
  setComputerWorkdirPatch,
  validateComputerWorkdir,
  DEFAULT_COMPUTER_WORKDIR,
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

  // The Claude Code harness runs inside this computer, so it can't be detached
  // while a harness is selected (the backend enforces `harness ⇒ computer`).
  // Remove the harness first (e.g. on the Behavior tab) to free the toggle.
  const lockedByHarness =
    draft.harness !== undefined && draft.computer !== undefined;

  // Working directory (COMP-16). Locally-buffered text so keystrokes don't
  // re-hash the whole host config; committed on blur. The stored value clears to
  // undefined at the default, so the placeholder shows the effective default.
  const attached = draft.computer !== undefined;
  const storedWorkdir = draft.computer?.workdir ?? "";
  const [workdirText, setWorkdirText] = useState(storedWorkdir);
  useEffect(() => {
    // Re-sync when the draft changes underneath us (host switch, external edit).
    setWorkdirText(storedWorkdir);
  }, [storedWorkdir]);
  const workdirError = validateComputerWorkdir(workdirText);
  const commitWorkdir = () => {
    if (workdirError) return; // keep the invalid text visible for correction
    update(setComputerWorkdirPatch(draft, workdirText));
  };

  return (
    <div className="flex flex-col gap-4">
      <FocusBlock title="Computer">
        <FieldRow
          label="Personal computer"
          description={
            lockedByHarness
              ? "Required by the Claude Code harness — remove the harness to detach. A per-member cloud workstation (a persistent Linux sandbox) the real Claude Code runtime runs inside."
              : "Attach a per-member cloud workstation (a persistent Linux sandbox). Required by computer-backed tools like Bash, which you enable in the Tools tab."
          }
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
              disabled={readOnly || lockedByHarness}
            />
          }
        />
        {attached && (
          <FieldRow
            label="Working directory"
            description={
              "Where the bash tool runs and the terminal opens (the harness " +
              "Shell runs in a per-session folder beneath it). Must be under " +
              "/home/user; chat attachments land in /home/user/attachments, so " +
              "the default keeps relative paths working."
            }
            control={
              <div className="flex flex-col items-end gap-1">
                <Input
                  value={workdirText}
                  onChange={(e) => setWorkdirText(e.target.value)}
                  onBlur={commitWorkdir}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitWorkdir();
                    }
                  }}
                  placeholder={DEFAULT_COMPUTER_WORKDIR}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  aria-label="Working directory"
                  aria-invalid={workdirError ? true : undefined}
                  disabled={readOnly}
                  className="w-64 font-mono text-xs"
                />
                {workdirError && (
                  <span className="text-xs text-red-500">{workdirError}</span>
                )}
              </div>
            }
          />
        )}
      </FocusBlock>
    </div>
  );
}
