import { useMemo, useState, type FormEvent } from "react";
import { useMcpConnections } from "../hooks/useMcpConnections";

function normalizeScopes(value: string): string[] | undefined {
  const scopes = value
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  return scopes.length > 0 ? scopes : undefined;
}

function parseHeaders(value: string): Record<string, string> | undefined {
  if (!value.trim()) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Headers must be a JSON object.");
  }

  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(parsed)) {
    if (typeof headerValue !== "string") {
      throw new Error(`Header "${key}" must be a string value.`);
    }
    headers[key] = headerValue;
  }
  return headers;
}

export function ServerConnectionsPage() {
  const {
    servers,
    activeServerId,
    setActiveServerId,
    connectServer,
    disconnectServer,
    reconnectServer,
    removeServer,
    refreshServerCapabilities,
  } = useMcpConnections();

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [transport, setTransport] = useState<"streamable-http" | "sse">(
    "streamable-http",
  );
  const [useOAuth, setUseOAuth] = useState(false);
  const [scopes, setScopes] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [headersJson, setHeadersJson] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const connectedCount = useMemo(
    () => servers.filter((server) => server.connectionStatus === "connected").length,
    [servers],
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    setIsSubmitting(true);

    try {
      const headers = parseHeaders(headersJson);
      await connectServer({
        name: name.trim(),
        url: url.trim(),
        transport,
        headers,
        oauth: useOAuth
          ? {
              enabled: true,
              scopes: normalizeScopes(scopes),
              clientId: clientId.trim() || undefined,
              clientSecret: clientSecret.trim() || undefined,
            }
          : {
              enabled: false,
            },
      });
      setName("");
      setUrl("");
      setScopes("");
      setClientId("");
      setClientSecret("");
      setHeadersJson("");
      setUseOAuth(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Connection failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="page">
      <div className="page__header">
        <h1>Server Connections</h1>
        <p>Manage remote HTTPS MCP servers and OAuth dynamic registration.</p>
      </div>

      <div className="card-stack">
        <article className="card">
          <div className="card__header">
            <h2>Add Server</h2>
            <span className="status-badge">
              {connectedCount} connected / {servers.length} total
            </span>
          </div>
          <form className="server-form" onSubmit={handleSubmit}>
            <div className="form-grid">
              <label>
                <span>Name</span>
                <input
                  className="text-input"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Acme MCP"
                />
              </label>
              <label>
                <span>URL</span>
                <input
                  className="text-input"
                  required
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/mcp"
                />
              </label>
              <label>
                <span>Transport</span>
                <select
                  className="text-input"
                  value={transport}
                  onChange={(e) =>
                    setTransport(e.target.value as "streamable-http" | "sse")
                  }
                >
                  <option value="streamable-http">Streamable HTTP</option>
                  <option value="sse">SSE</option>
                </select>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={useOAuth}
                  onChange={(e) => setUseOAuth(e.target.checked)}
                />
                <span>Use OAuth + Dynamic Client Registration</span>
              </label>
            </div>

            {useOAuth && (
              <div className="form-grid">
                <label>
                  <span>Scopes (comma separated)</span>
                  <input
                    className="text-input"
                    value={scopes}
                    onChange={(e) => setScopes(e.target.value)}
                    placeholder="read,write"
                  />
                </label>
                <label>
                  <span>Client ID (optional)</span>
                  <input
                    className="text-input"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                  />
                </label>
                <label>
                  <span>Client Secret (optional)</span>
                  <input
                    className="text-input"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    type="password"
                  />
                </label>
              </div>
            )}

            <label>
              <span>Headers JSON (optional)</span>
              <textarea
                className="text-input text-input--multiline"
                value={headersJson}
                onChange={(e) => setHeadersJson(e.target.value)}
                placeholder='{"x-api-key":"..."}'
              />
            </label>

            {formError && <p className="error-text">{formError}</p>}

            <div className="row-actions">
              <button className="btn btn--primary" type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Connecting..." : "Connect"}
              </button>
            </div>
          </form>
        </article>

        <article className="card">
          <h2>Configured Servers</h2>
          {servers.length === 0 ? (
            <p className="muted">No servers configured yet.</p>
          ) : (
            <ul className="server-list">
              {servers.map((server) => {
                const isActive = server.id === activeServerId;
                return (
                  <li key={server.id} className="server-item">
                    <div className="server-item__main">
                      <button
                        type="button"
                        className={isActive ? "link-btn link-btn--active" : "link-btn"}
                        onClick={() => setActiveServerId(server.id)}
                      >
                        {server.name}
                      </button>
                      <p>{server.url}</p>
                      {server.lastError && (
                        <p className="error-text">
                          {server.lastError.message}
                          {server.lastError.retryable ? " (retryable)" : ""}
                        </p>
                      )}
                      {server.serverCapabilities != null && (
                        <p className="muted">
                          Capabilities: {Object.keys(server.serverCapabilities as object).join(", ") || "available"}
                        </p>
                      )}
                    </div>
                    <div className="server-item__actions server-item__actions--stacked">
                      <span className="status-badge">{server.connectionStatus}</span>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => reconnectServer(server.id)}
                      >
                        Reconnect
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => disconnectServer(server.id)}
                      >
                        Disconnect
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => refreshServerCapabilities(server.id)}
                      >
                        Refresh Capabilities
                      </button>
                      <button
                        type="button"
                        className="btn btn--danger"
                        onClick={() => removeServer(server.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </article>
      </div>
    </section>
  );
}
