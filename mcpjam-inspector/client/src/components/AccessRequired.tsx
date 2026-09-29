import { useEffect, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  ACCESS_GRANTED_EVENT,
  LOCAL_ACCESS_KEY,
  parseAccessLink,
} from "@/lib/access-link";
import { copyToClipboard } from "@/lib/clipboard";
import { confirmAccessToken } from "@/lib/session-token";
import {
  getInitialThemeMode,
  getInitialThemePreset,
  updateThemeMode,
  updateThemePreset,
} from "@/lib/theme-utils";

export function AccessRequired({ restarted = false }: { restarted?: boolean }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  async function accept(raw: string) {
    const token = parseAccessLink(raw);
    if (!token) {
      setError(true);
      return;
    }
    setBusy(true);
    try {
      await confirmAccessToken(token);
      setValue("");
      window.dispatchEvent(new Event(ACCESS_GRANTED_EVENT));
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    updateThemeMode(getInitialThemeMode());
    updateThemePreset(getInitialThemePreset());
    const receive = (event: StorageEvent) => {
      if (event.key === LOCAL_ACCESS_KEY && event.newValue)
        void accept(event.newValue);
    };
    window.addEventListener("storage", receive);
    return () => window.removeEventListener("storage", receive);
  }, []);
  return (
    <main className="flex h-screen overflow-y-auto bg-background px-6 py-12 text-foreground">
      <div className="m-auto w-full max-w-md space-y-6 text-center">
        <img src="/mcp_jam.svg" alt="MCPJam" className="mx-auto h-16 w-auto" />
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">
            {restarted ? "MCPJam restarted" : "Open MCPJam from your terminal"}
          </h1>
          <p>
            {restarted
              ? "Open the new link from your terminal to continue."
              : "For your security, this browser needs the link MCPJam printed when it started."}
          </p>
        </div>
        <div className="overflow-hidden rounded-lg border border-border bg-code-bg p-4 text-left font-code text-sm text-code-text">
          ➜ Local&nbsp; http://localhost:6274/#token=…
        </div>
        <p className="text-sm">
          This page continues once you open the link at the same address. Using
          another address or computer? Paste the link below.
        </p>
        <div className="space-y-2 text-sm">
          <p>Running in Docker?</p>
          <code className="font-code">docker logs &lt;container&gt;</code>{" "}
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void copyToClipboard("docker logs <container>").then(setCopied)
            }
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <details className="text-left">
          <summary className="cursor-pointer text-sm">
            Paste the link instead
          </summary>
          <form
            className="mt-3 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void accept(value);
            }}
          >
            <label htmlFor="access-link" className="text-sm">
              Link or code from your terminal
            </label>
            <Input
              id="access-link"
              type="password"
              autoComplete="off"
              className="ph-no-capture"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setError(false);
              }}
            />
            {error && (
              <p role="alert" className="text-sm text-destructive">
                That link didn't work. Use the newest link in your terminal.
              </p>
            )}
            <Button
              type="submit"
              variant="secondary"
              disabled={busy || !value.trim()}
            >
              {busy ? "Opening…" : "Open MCPJam"}
            </Button>
          </form>
        </details>
      </div>
    </main>
  );
}
