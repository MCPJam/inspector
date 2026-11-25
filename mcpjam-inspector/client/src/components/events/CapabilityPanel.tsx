import { JsonEditor } from "@/components/ui/json-editor";
import type { EventsListResponse } from "@/shared/events-api";

const SOURCE_LABELS: Record<string, string> = {
  initialize: "initialize result",
  "server/discover": "server/discover result",
};

/**
 * What the server declared, exactly as the handshake carried it (contract
 * C10): the negotiated Events declaration, where it was read from, the
 * negotiated protocol version, and the raw `capabilities` object.
 */
export function CapabilityPanel({ catalog }: { catalog: EventsListResponse }) {
  const { support } = catalog;
  const capabilityPath = support.beta
    ? 'capabilities.extensions["io.modelcontextprotocol/events"]'
    : "capabilities.events";
  return (
    <div className="space-y-2" data-testid="events-capability">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-xs text-muted-foreground">
          {support.declared ? "Events declared" : "MCP Events capability missing"}
        </span>
        {support.declared && support.listChanged ? (
          <span className="text-[11px] text-muted-foreground">
            listChanged: true
          </span>
        ) : null}
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
        <div>
          <dt className="inline text-muted-foreground">Read from </dt>
          <dd className="inline font-mono text-foreground">
            {support.source
              ? (SOURCE_LABELS[support.source] ?? support.source)
              : support.handshakeObserved
                ? "handshake"
                : "no handshake observed yet"}
          </dd>
        </div>
        <div>
          <dt className="inline text-muted-foreground">Protocol version </dt>
          <dd className="inline font-mono text-foreground">
            {catalog.protocolVersion ?? "unknown"}
          </dd>
        </div>
      </dl>
      {support.capability ? (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted-foreground">
            {capabilityPath}
          </summary>
          <div className="mt-1 max-h-48 overflow-auto rounded-md border border-border">
            <JsonEditor
              value={support.capability}
              viewOnly
              collapsible
              defaultExpandDepth={3}
            />
          </div>
        </details>
      ) : null}
      {catalog.rawCapabilities ? (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-muted-foreground">
            Raw capabilities
          </summary>
          <div className="mt-1 max-h-64 overflow-auto rounded-md border border-border">
            <JsonEditor
              value={catalog.rawCapabilities}
              viewOnly
              collapsible
              defaultExpandDepth={2}
            />
          </div>
        </details>
      ) : null}
    </div>
  );
}
