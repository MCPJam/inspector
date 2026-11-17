import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Plug, Plus } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { ServerPickerServerList } from "@mcpjam/design-system/server-picker-panel";
import { AddServerModal } from "@/components/connection/AddServerModal";
import { getConnectionStatusMeta } from "@/components/connection/server-card-utils";
import { SearchInput } from "@/components/ui/search-input";
import type { EnsureServersReadyResult } from "@/hooks/use-app-state";
import { track } from "@/lib/analytics";
import type { ServerFormData } from "@/shared/types";
import type { ServerWithName } from "@/state/app-types";

interface PlaygroundServerConnectButtonProps {
  servers: Record<string, ServerWithName>;
  catalogKnown: boolean;
  onAddServer: (formData: ServerFormData) => void;
  ensureServersReady?: (
    names: string[],
    options?: { allowInteractiveOAuthFlow?: boolean },
  ) => Promise<EnsureServersReadyResult>;
  /** Commits the pick before OAuth can navigate away; returns its undo. */
  onChooseServer?: (name: string) => (() => void) | undefined;
  onConnected?: (name: string) => void;
  onPendingChange: (pending: boolean) => void;
}

export function PlaygroundServerConnectButton({
  servers,
  catalogKnown,
  onAddServer,
  ensureServersReady,
  onChooseServer,
  onConnected,
  onPendingChange,
}: PlaygroundServerConnectButtonProps) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  // The shared selection and pane overrides can change during the handshake.
  const latestOnConnected = useRef(onConnected);
  useLayoutEffect(() => {
    latestOnConnected.current = onConnected;
  }, [onConnected]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (inFlight.current) onPendingChange(false);
    };
  }, [onPendingChange]);

  const names = Object.keys(servers);
  const addServer = () => {
    setOpen(false);
    setAdding(true);
  };
  useEffect(() => {
    if (open && catalogKnown && names.length === 0) {
      setOpen(false);
      setAdding(true);
    }
  }, [open, catalogKnown, names.length]);

  const connect = async (name: string) => {
    if (inFlight.current || !ensureServersReady) return;
    inFlight.current = true;
    setPendingName(name);
    setError(null);
    onPendingChange(true);
    track("connecting_server", { location: "playground_tools_rail" });
    let undoChoice: (() => void) | undefined;
    try {
      undoChoice = onChooseServer?.(name);
      const result = await ensureServersReady([name], {
        allowInteractiveOAuthFlow: true,
      });
      const ready = result.readyServerNames.includes(name);
      // "reauth" also covers a redirect in flight, which needs the pick.
      const reauth = result.reauthServerNames.includes(name);
      if (!ready && !reauth) undoChoice?.();
      if (!mounted.current) return;
      if (ready) {
        latestOnConnected.current?.(name);
        setOpen(false);
      } else if (reauth) {
        setError(`${name} needs authorization. Click Connect to sign in.`);
      } else if (result.missingServerNames.includes(name)) {
        setError(
          `${name} is no longer available. Choose another server or add one.`,
        );
      } else {
        setError(
          `Could not connect to ${name}. Check that the server is running and try again.`,
        );
      }
    } catch {
      undoChoice?.();
      if (mounted.current) {
        setError(
          `Could not connect to ${name}. Check that the server is running and try again.`,
        );
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setPendingName(null);
        onPendingChange(false);
      }
    }
  };

  const rows = names
    .filter((name) => name.toLowerCase().includes(query.trim().toLowerCase()))
    .map((name) => ({
      id: name,
      name,
      status:
        pendingName === name
          ? { label: "Connecting…", indicatorClassName: "bg-info" }
          : getConnectionStatusMeta(servers[name].connectionStatus),
      onConnect: ensureServersReady ? () => void connect(name) : undefined,
    }));

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next && catalogKnown && names.length === 0) {
            addServer();
          } else {
            setOpen(next);
            if (next) setQuery("");
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">
            <Plug className="h-3.5 w-3.5" />
            Connect a server
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-80 max-w-[calc(100vw-2rem)] p-0"
          aria-label="Connect a saved server"
        >
          <div className="space-y-2 border-b border-border p-3">
            <p className="text-sm font-medium">Connect a saved server</p>
            <SearchInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search servers…"
            />
          </div>
          <div className="max-h-64 overflow-y-auto p-1">
            {catalogKnown && rows.length === 0 && query.trim() ? (
              <p className="p-3 text-xs text-muted-foreground">
                No servers match your search.
              </p>
            ) : (
              <ServerPickerServerList
                servers={rows}
                catalogKnown={catalogKnown}
                busy={pendingName !== null || !catalogKnown}
                onSelectServer={(name) => void connect(name)}
              />
            )}
          </div>
          <div className="border-t border-border p-1">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={addServer}
              disabled={pendingName !== null || !catalogKnown}
            >
              <Plus className="size-3.5" />
              Add server
            </Button>
          </div>
          {pendingName && (
            <p
              role="status"
              className="border-t border-border p-3 text-xs text-muted-foreground"
            >
              Connecting to {pendingName}…
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="border-t border-border p-3 text-xs text-destructive"
            >
              {error}
            </p>
          )}
        </PopoverContent>
      </Popover>
      <AddServerModal
        isOpen={adding}
        onClose={() => setAdding(false)}
        onSubmit={(formData) => {
          track("connecting_server", { location: "playground_tools_rail" });
          onAddServer(formData);
          setAdding(false);
        }}
      />
    </>
  );
}
