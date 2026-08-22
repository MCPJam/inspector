import { useState } from "react";

/**
 * Shown when the session-token bootstrap is denied with a 403 because the
 * inspector is being reached over the network (a non-localhost host that isn't
 * in `MCPJAM_ALLOWED_HOSTS`).
 *
 * This is the self-hosted-over-the-network case (raw IP / Docker on a remote
 * box). The old screen told these users to "use localhost instead", which is
 * unreachable for them — a dead end. Instead, show the exact host they're on
 * and the one env var that unblocks it, so they can self-serve.
 *
 * Rendered from the bootstrap catch in `main.tsx` BEFORE the app/providers
 * mount, so it is intentionally self-contained: inline styles (no dependency
 * on app CSS having applied) and no router/provider context.
 */
export function NetworkAccessError() {
  // `host` includes the port (what the user typed); the allowlist compares on
  // hostname only (port is stripped server-side), so that's the value to set.
  const host =
    typeof window !== "undefined" ? window.location.host : "your-host";
  const hostname =
    typeof window !== "undefined" ? window.location.hostname : "your-host";
  const envValue = `MCPJAM_ALLOWED_HOSTS=${hostname}`;

  const [copied, setCopied] = useState(false);
  const copyEnvValue = () => {
    try {
      void navigator.clipboard?.writeText(envValue).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    } catch {
      // Clipboard can be unavailable (insecure context / permissions). The
      // value is on screen to copy by hand — no need to surface a failure.
    }
  };

  const codeBoxStyle: React.CSSProperties = {
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    fontSize: "0.875rem",
    background: "#f4f4f5",
    color: "#18181b",
    border: "1px solid #e4e4e7",
    borderRadius: "0.5rem",
    padding: "0.625rem 0.75rem",
    textAlign: "left",
    wordBreak: "break-all",
  };

  return (
    <div
      style={{
        padding: "2rem",
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        color: "#18181b",
      }}
    >
      <div style={{ maxWidth: "460px", width: "100%", textAlign: "center" }}>
        <img
          src="/mcp_jam.svg"
          alt="MCPJam Logo"
          style={{ width: "96px", height: "auto", marginBottom: "1.5rem" }}
        />
        <h1 style={{ fontSize: "1.375rem", marginBottom: "0.5rem" }}>
          Network access needs configuration
        </h1>
        <p style={{ color: "#3f3f46", marginBottom: "0.25rem" }}>
          You're reaching the inspector at{" "}
          <strong style={{ wordBreak: "break-all" }}>{host}</strong>.
        </p>
        <p
          style={{
            color: "#52525b",
            fontSize: "0.9rem",
            marginBottom: "1.25rem",
            lineHeight: 1.5,
          }}
        >
          For security, the session token is only issued to{" "}
          <code>localhost</code> or hosts you explicitly allow. To use the
          inspector over the network, add this host to the{" "}
          <code>MCPJAM_ALLOWED_HOSTS</code> environment variable, then restart.
        </p>

        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            alignItems: "stretch",
            marginBottom: "0.5rem",
          }}
        >
          <code style={{ ...codeBoxStyle, flex: 1 }}>{envValue}</code>
          <button
            onClick={copyEnvValue}
            style={{
              padding: "0 0.875rem",
              cursor: "pointer",
              background: "#18181b",
              color: "#fff",
              border: "none",
              borderRadius: "0.5rem",
              fontSize: "0.8125rem",
              fontWeight: 500,
              whiteSpace: "nowrap",
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p
          style={{
            color: "#71717a",
            fontSize: "0.8125rem",
            marginBottom: "1.5rem",
            lineHeight: 1.5,
          }}
        >
          Running in Docker? Pass{" "}
          <code>-e MCPJAM_ALLOWED_HOSTS={hostname}</code> to the container.
          Comma-separate multiple hosts, or use a wildcard like{" "}
          <code>*.example.com</code>. Alternatively, open{" "}
          <code>http://localhost</code> on the machine running the inspector.
        </p>

        <button
          onClick={() => location.reload()}
          style={{
            padding: "0.75rem 1.5rem",
            cursor: "pointer",
            backgroundColor: "#18181b",
            color: "#fff",
            border: "none",
            borderRadius: "0.5rem",
            fontSize: "1rem",
            fontWeight: 500,
          }}
        >
          Retry
        </button>
      </div>
    </div>
  );
}
