import { Switch } from "@mcpjam/design-system/switch";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

/**
 * Servers-tab header control for `autoConnectServersEnabled`.
 *
 * Auto-connect is a personal, per-device preference: it decides whether THIS
 * browser opens every project server automatically for the Playground and
 * debugger tabs. It is the only flag `useAutoConnectProjectServers` reads, so
 * what the switch shows is exactly what happens. It is deliberately not
 * admin-gated and writes nothing to the project — evals, swarms and user
 * testing pick their own server groups and never consult it.
 */
export function ServersAutoConnectSwitch({
  onToggled,
}: {
  /** Fired after the preference is written, with the new value. */
  onToggled?: (next: boolean) => void;
}) {
  const enabled = usePreferencesStore((s) => s.autoConnectServersEnabled);
  const setEnabled = usePreferencesStore((s) => s.setAutoConnectServersEnabled);

  return (
    <label
      className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground select-none"
      title="Connect every project server automatically in the Playground and debugger tabs. Only this device — evals and swarms manage their own connections."
    >
      <Switch
        checked={enabled}
        onCheckedChange={(next) => {
          setEnabled(next);
          onToggled?.(next);
        }}
        aria-label="Auto-connect servers on this device"
      />
      <span>Auto-connect</span>
    </label>
  );
}
