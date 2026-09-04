import { useState } from "react";

/**
 * Shown when the session-token bootstrap is denied with a 403 because the
 * inspector is being reached over the network (a non-localhost host that isn't
 * in `MCPJAM_ALLOWED_HOSTS`) — the self-hosted-over-the-network case (raw IP /
 * Docker on a remote box).
 *
 * Shows the exact host the user is on and the one env var that unblocks it, so
 * they can self-serve rather than dead-end.
 *
 * Rendered from the bootstrap catch in `main.tsx` BEFORE the app/providers
 * mount, so it is intentionally self-contained: inline styles (no dependency
 * on app CSS having applied) and no router/provider context.
 */
export function NetworkAccessError() {
  // `host` includes the port (what the user typed); the allowlist compares on
  // hostname only (port is stripped server-side), so that's the value to set.
  // This screen only ever mounts in the browser (from main.tsx), so read
  // `window.location` directly — same as the `location.reload()` below.
  const host = window.location.host;
  const hostname = window.location.hostname;
  const envValue = `MCPJAM_ALLOWED_HOSTS=${hostname}`;

  const [copied, setCopied] = useState(false);
  const flashCopied = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const copyEnvValue = async () => {
    // `navigator.clipboard` is secure-context only — and this screen's whole
    // target case is a plain-HTTP LAN IP (e.g. http://192.168.1.50:6274),
    // which is NOT a secure context, so it's usually undefined here. Await the
    // write (its rejection is async — a bare try/catch never sees it, and an
    // unhandled rejection would report to Sentry, which this path is meant to
    // avoid), then fall back to a select+execCommand copy, and finally to the
    // value already on screen for a manual copy.
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(envValue);
        flashCopied();
        return;
      }
    } catch {
      // fall through to the execCommand fallback
    }
    try {
      const textarea = document.createElement("textarea");
      textarea.value = envValue;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      // Remove the node in `finally` so an unavailable/throwing execCommand
      // can't leak an invisible fixed textarea on every failed Copy click.
      try {
        textarea.focus();
        textarea.select();
        if (document.execCommand("copy")) flashCopied();
      } finally {
        document.body.removeChild(textarea);
      }
    } catch {
      // Give up silently; the value is visible above for a manual copy.
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
        boxSizing: "border-box",
        padding: "2rem",
        fontFamily: "system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        // Bound the height to exactly one viewport and scroll internally. The
        // global #root is overflow:hidden, so an unbounded minHeight:100vh
        // element grows PAST the clipped root and overflowY never engages —
        // stranding the guidance and Retry button on short/mobile viewports.
        // maxHeight + border-box clamps it to the viewport; the inner card's
        // auto margins center it when there's room and let it scroll (without
        // clipping the top, which justifyContent:center would) when there isn't.
        minHeight: "100vh",
        maxHeight: "100vh",
        overflowY: "auto",
        // Explicit light surface + dark text so the screen is legible
        // regardless of the page theme behind it. This renders at bootstrap,
        // before the app applies the stored (possibly dark) theme, so it can't
        // rely on theme tokens; a self-contained light card is always readable.
        backgroundColor: "#ffffff",
        color: "#18181b",
      }}
    >
      <div
        style={{
          margin: "auto 0",
          maxWidth: "460px",
          width: "100%",
          textAlign: "center",
        }}
      >
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
            onClick={() => void copyEnvValue()}
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
