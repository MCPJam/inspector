import { useMcpConnections } from "../hooks/useMcpConnections";

export function PlaygroundPage() {
  const { servers, activeServerId } = useMcpConnections();
  const activeServer = servers.find((server) => server.id === activeServerId) ?? null;

  return (
    <section className="page">
      <div className="page__header">
        <h1>LLM Playground</h1>
        <p>Chat UI scaffold for MCP-connected model interactions.</p>
      </div>

      <div className="card-stack">
        <article className="card">
          <h2>Session Context</h2>
          <p className="muted">
            {activeServer
              ? `Active server: ${activeServer.name}`
              : "No active server selected. Choose one from Server Connections."}
          </p>
        </article>

        <article className="card">
          <h2>Chat Area (Placeholder)</h2>
          <p className="muted">
            Streaming, model selection, and MCP tool invocation will be wired in phase 2.
          </p>
          <div className="chat-placeholder">
            <div className="chat-placeholder__bubble">Assistant output will stream here.</div>
            <div className="chat-placeholder__input">Message composer goes here.</div>
          </div>
        </article>
      </div>
    </section>
  );
}
