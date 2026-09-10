import { Switch } from "@mcpjam/design-system/switch";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

/**
 * Servers-tab header control for `autoConnectServersEnabled`.
 *
 * The connect hook (`useAutoConnectProjectServers`) reads that preference.
 * The same switch also enrolls/unenrolls catalog servers in project config
 * via `onEnrollmentChange` — that is a separate side-effect, not the flag
 * the hook actually consults.
 */
export function ServersAutoConnectSwitch({
  disabled,
  canManage,
  onEnrollmentChange,
}: {
  disabled: boolean;
  canManage: boolean;
  onEnrollmentChange: (next: boolean) => void | Promise<void>;
}) {
  const enabled = usePreferencesStore((s) => s.autoConnectServersEnabled);
  const setEnabled = usePreferencesStore((s) => s.setAutoConnectServersEnabled);

  return (
    <label
      className={cn(
        "flex items-center gap-2 text-xs text-muted-foreground select-none",
        disabled ? "cursor-not-allowed" : "cursor-pointer",
      )}
      title={
        canManage
          ? "Auto-connect every project server when a client opens"
          : "Only project admins can change auto-connect"
      }
    >
      <Switch
        checked={enabled}
        disabled={disabled}
        onCheckedChange={(next) => {
          setEnabled(next);
          void onEnrollmentChange(next);
        }}
        aria-label="Auto-connect project servers"
      />
      <span>Auto-connect</span>
    </label>
  );
}
