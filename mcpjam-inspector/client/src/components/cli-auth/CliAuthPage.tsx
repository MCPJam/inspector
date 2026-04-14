import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";

type Phase =
  | "loading"
  | "invalid-params"
  | "signin"
  | "confirm"
  | "minting"
  | "posting"
  | "success"
  | "error"
  | "display-code";

type WorkspaceSummary = {
  _id: string;
  name: string;
};

interface ParsedParams {
  port: number;
  state: string;
  displayMode: "browser" | "code";
  version?: string;
}

/**
 * CLI login handshake target. `mcpjam login` opens this page with:
 *   - `port`  — the loopback port the CLI is listening on (127.0.0.1)
 *   - `state` — a 43-char base64url CSRF token bound to that login attempt
 *   - `version` (optional) — CLI version for display
 *   - `display=code` (optional) — render a pasteable API key instead of
 *     POSTing to the loopback (used when the CLI ran with `--no-browser`).
 *
 * We rotate the workspace API key via `apiKeys.regenerateAndGet` (same
 * mutation the Settings UI uses), then POST `{ apiKey, state, user, workspace }`
 * to the CLI's loopback `/callback`.
 */
export default function CliAuthPage() {
  const parsed = useParsedParams();
  const { isLoading: isAuthLoading, isAuthenticated } = useConvexAuth();
  const { signIn, user: workosUser } = useAuth();
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    null,
  );

  const workspaces = useQuery(
    "workspaces:getMyWorkspaces" as any,
    isAuthenticated ? ({} as any) : "skip",
  ) as WorkspaceSummary[] | undefined;

  const regenerateAndGet = useMutation(
    "apiKeys:regenerateAndGet" as any,
  ) as unknown as (args: { workspaceId?: string }) => Promise<{
    apiKey: string;
    key: { prefix: string };
  }>;

  // Preselect the first workspace once the list loads.
  useEffect(() => {
    if (!selectedWorkspaceId && workspaces && workspaces.length > 0) {
      setSelectedWorkspaceId(workspaces[0]._id);
    }
  }, [workspaces, selectedWorkspaceId]);

  // Phase machine driven by auth + params.
  useEffect(() => {
    if (phase === "success" || phase === "error" || phase === "display-code") {
      return;
    }
    if (!parsed) {
      setPhase("invalid-params");
      return;
    }
    if (isAuthLoading) {
      setPhase("loading");
      return;
    }
    if (!isAuthenticated) {
      setPhase("signin");
      return;
    }
    if (phase === "signin" || phase === "loading") {
      setPhase("confirm");
    }
  }, [phase, parsed, isAuthLoading, isAuthenticated]);

  async function handleAuthorize() {
    if (!parsed || !selectedWorkspaceId) return;
    setPhase("minting");
    setError(null);
    try {
      const result = await regenerateAndGet({
        workspaceId: selectedWorkspaceId,
      });
      setApiKey(result.apiKey);

      const workspace = workspaces?.find(
        (w) => w._id === selectedWorkspaceId,
      );

      if (parsed.displayMode === "code") {
        setPhase("display-code");
        return;
      }

      setPhase("posting");
      const res = await fetch(`http://127.0.0.1:${parsed.port}/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          state: parsed.state,
          apiKey: result.apiKey,
          user: {
            userId: "",
            email: workosUser?.email ?? "",
            name:
              [workosUser?.firstName, workosUser?.lastName]
                .filter(Boolean)
                .join(" ")
                .trim() ||
              (workosUser?.email ?? ""),
            workspaceId: selectedWorkspaceId,
            workspaceName: workspace?.name ?? null,
            keyPrefix: result.key.prefix,
          },
        }),
      });
      if (!res.ok) {
        throw new Error(
          `Loopback callback returned HTTP ${res.status}. ` +
            "The CLI may have already exited — please run `mcpjam login` again.",
        );
      }
      setPhase("success");
    } catch (err: any) {
      setError(err?.message ?? String(err));
      // Fall back to displaying the key if we actually minted one, so the
      // user can paste it manually.
      setPhase(apiKey ? "display-code" : "error");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-border/40 bg-background p-8 shadow-sm">
        <div className="flex items-center gap-3 mb-6">
          <img
            src="/mcp_jam.svg"
            alt="MCPJam"
            className="w-9 h-9"
          />
          <div>
            <h1 className="text-lg font-semibold">Authorize MCPJam CLI</h1>
            <p className="text-xs text-muted-foreground">
              {parsed?.version
                ? `mcpjam CLI v${parsed.version}`
                : "mcpjam CLI"}
            </p>
          </div>
        </div>

        {phase === "invalid-params" && (
          <ErrorBlock
            title="Invalid login request"
            message="This page is only meant to be opened by the MCPJam CLI. Run `mcpjam login` from your terminal."
          />
        )}

        {phase === "loading" && <Loading label="Checking sign-in…" />}

        {phase === "signin" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Sign in to your MCPJam account to continue.
            </p>
            <Button
              className="w-full"
              onClick={() => {
                // Preserve the entire search string so post-callback we land
                // back on /cli-auth with the same port+state.
                try {
                  sessionStorage.setItem(
                    "mcpjam.cli-auth.search",
                    window.location.search,
                  );
                } catch {
                  /* ignore */
                }
                signIn();
              }}
            >
              Sign in
            </Button>
          </div>
        )}

        {phase === "confirm" && parsed && (
          <div className="space-y-4">
            <p className="text-sm">
              The MCPJam CLI on your machine is asking to access your workspace.
              A <strong>new API key</strong> will be minted — this invalidates
              any existing workspace API key already in use elsewhere.
            </p>
            {workspaces === undefined ? (
              <Loading label="Loading workspaces…" />
            ) : workspaces.length === 0 ? (
              <ErrorBlock
                title="No workspaces available"
                message="Create a workspace first, then rerun `mcpjam login`."
              />
            ) : (
              <>
                <label className="block text-xs text-muted-foreground">
                  Workspace to authorize
                </label>
                <Select
                  value={selectedWorkspaceId ?? undefined}
                  onValueChange={(v) => setSelectedWorkspaceId(v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a workspace" />
                  </SelectTrigger>
                  <SelectContent>
                    {workspaces.map((w) => (
                      <SelectItem key={w._id} value={w._id}>
                        {w.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex gap-2 pt-2">
                  <Button
                    className="flex-1"
                    onClick={handleAuthorize}
                    disabled={!selectedWorkspaceId}
                  >
                    Authorize CLI
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => window.close()}
                  >
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {phase === "minting" && <Loading label="Creating API key…" />}
        {phase === "posting" && <Loading label="Sending key to CLI…" />}

        {phase === "success" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-green-600">
              <CheckCircle2 className="w-5 h-5" />
              <span className="font-medium">CLI authorized</span>
            </div>
            <p className="text-sm text-muted-foreground">
              You can close this tab and return to your terminal.
            </p>
          </div>
        )}

        {phase === "display-code" && apiKey && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="w-5 h-5" />
              <span className="font-medium">Manual paste required</span>
            </div>
            <p className="text-sm text-muted-foreground">
              {error
                ? "Automatic handoff failed, but your key was minted. "
                : "You used --no-browser, so we can't POST to your CLI. "}
              Copy the key below and paste it back into the terminal.
            </p>
            <Input
              readOnly
              value={apiKey}
              className="font-mono text-xs"
              onFocus={(e) => e.currentTarget.select()}
            />
            <p className="text-xs text-muted-foreground">
              The key is shown once. Treat it like a password.
            </p>
          </div>
        )}

        {phase === "error" && (
          <ErrorBlock
            title="Login failed"
            message={error ?? "An unknown error occurred."}
          />
        )}
      </div>
    </div>
  );
}

function useParsedParams(): ParsedParams | null {
  return useMemo(() => {
    if (typeof window === "undefined") return null;
    let search = window.location.search;
    // Restore search after a WorkOS sign-in round-trip.
    if (!search || search === "?") {
      try {
        const saved = sessionStorage.getItem("mcpjam.cli-auth.search");
        if (saved && saved.startsWith("?")) {
          search = saved;
          sessionStorage.removeItem("mcpjam.cli-auth.search");
          window.history.replaceState(
            null,
            "",
            `${window.location.pathname}${search}`,
          );
        }
      } catch {
        /* ignore */
      }
    }

    const params = new URLSearchParams(search);
    const portStr = params.get("port");
    const state = params.get("state");
    if (!portStr || !state) return null;
    const port = Number.parseInt(portStr, 10);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
    // base64url: A-Z a-z 0-9 _ -, 43 chars for 32 bytes.
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(state)) return null;
    const displayMode: "browser" | "code" =
      params.get("display") === "code" ? "code" : "browser";
    const version = params.get("version") ?? undefined;
    return { port, state, displayMode, version };
  }, []);
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-muted-foreground text-sm">
      <Loader2 className="w-4 h-4 animate-spin" />
      {label}
    </div>
  );
}

function ErrorBlock({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-red-600">
        <AlertTriangle className="w-5 h-5" />
        <span className="font-medium">{title}</span>
      </div>
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
