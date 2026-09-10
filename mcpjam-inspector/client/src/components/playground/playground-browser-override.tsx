import { createContext, useContext, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";

export type BrowserOverride = boolean | null;
export const PlaygroundBrowserOverrideContext =
  createContext<BrowserOverride>(null);
export const usePlaygroundBrowserOverride = () =>
  useContext(PlaygroundBrowserOverrideContext);

/** Undefined follows the client; an explicit empty array disables its last tool. */
export function applyBrowserOverride(
  ids: string[] | undefined,
  override: BrowserOverride,
) {
  if (override === null) return ids;
  const rest = (ids ?? []).filter((id) => id !== "browser");
  return override ? [...rest, "browser"] : rest;
}

/** Kept only for the currently selected project/client/mode, never persisted. */
export function useScopedBrowserOverride(scope: string) {
  const [state, setState] = useState<{ scope: string; value: BrowserOverride }>(
    { scope, value: null },
  );
  if (state.scope !== scope) setState({ scope, value: null });
  return {
    override: state.scope === scope ? state.value : null,
    setOverride: (value: BrowserOverride) => setState({ scope, value }),
  };
}

export function PlaygroundBrowserOverrideControl({
  override,
  onChange,
  clientEnabled,
  environmentMode,
}: {
  override: BrowserOverride;
  onChange: (value: BrowserOverride) => void;
  clientEnabled: boolean;
  environmentMode: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
      <span>Browser</span>
      {environmentMode ? (
        <span className="text-muted-foreground">
          Controlled by the environment’s client
        </span>
      ) : (
        <>
          <Select
            value={override === null ? "inherit" : override ? "on" : "off"}
            onValueChange={(value) =>
              onChange(value === "inherit" ? null : value === "on")
            }
          >
            <SelectTrigger
              aria-label="Browser for this Playground"
              className="h-7 w-auto gap-2 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">
                Client default ({clientEnabled ? "On" : "Off"})
              </SelectItem>
              <SelectItem value="on">On for this Playground</SelectItem>
              <SelectItem value="off">Off for this Playground</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-muted-foreground">
            Temporary; client settings stay unchanged. Browser permission is
            separate.
          </span>
        </>
      )}
    </div>
  );
}
