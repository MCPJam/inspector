/** Tool evidence from the existing SDK trace envelope, with no AI turns required. */
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
export function RecordedToolDetails({ trace, metadata, error }: {
  trace: unknown;
  metadata?: Record<string, unknown>;
  error?: string;
}) {
  const envelope = record(trace);
  const parts = (Array.isArray(envelope.messages) ? envelope.messages : []).flatMap(message => {
    const content = record(message).content;
    return Array.isArray(content) ? content.map(record) : [];
  });
  const calls = parts.filter(part => part.type === "tool-call");
  const results = new Map(parts.filter(part => part.type === "tool-result").map(part => [part.toolCallId, part]));
  const spans = new Map((Array.isArray(envelope.spans) ? envelope.spans : []).map(record).map(span => [span.toolCallId, span]));
  const completeness = metadata?.captureCompleteness;
  const recorded = metadata?.sdkRecorderVersion === 1 || record(envelope.raw).sdkRecorderVersion === 1;
  return <div className="space-y-3" aria-label="Recorded tool details">
    {error && <div className="rounded-md border border-destructive/30 p-3 text-sm"><strong>Test failure</strong><pre className="mt-2 whitespace-pre-wrap break-words">{error}</pre></div>}
    {completeness === "unavailable" ? <p role="status" className="text-sm text-muted-foreground">Tool details could not be captured. {typeof metadata?.captureError === "string" ? metadata.captureError : ""}</p>
      : <>
        {completeness === "incomplete" && <p role="status" className="text-sm text-muted-foreground">Tool details are incomplete: the test ended before all tool calls finished.</p>}
        {calls.length === 0 && <p role="status" className="text-sm text-muted-foreground">{recorded ? "No tool calls recorded." : "Tool details unavailable for this older run."}</p>}
        {calls.map((call, index) => {
          const result = results.get(call.toolCallId);
          const output = record(result?.output);
          const response = output.value ?? result?.result;
          const span = spans.get(call.toolCallId);
          const failed = span?.status === "error" || output.type === "error-json" || record(response).isError === true;
          const duration = typeof span?.endMs === "number" && typeof span?.startMs === "number" ? Math.max(0, span.endMs - span.startMs) : undefined;
          return <section key={String(call.toolCallId ?? index)} className="space-y-3 rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <strong>{String(call.toolName ?? "Tool")}</strong>
              {typeof span?.serverId === "string" && <span className="text-muted-foreground">{span.serverId}</span>}
              <span className={failed ? "text-destructive" : "text-muted-foreground"}>{!result ? "Incomplete" : failed ? "Tool error" : "Success"}</span>
              {duration !== undefined && <span className="text-muted-foreground">{duration.toFixed(1)} ms</span>}
            </div>
            <details><summary className="cursor-pointer text-sm">Inputs</summary><pre className="mt-2 overflow-auto rounded bg-muted p-3 text-xs">{JSON.stringify(call.input ?? call.args ?? {}, null, 2)}</pre></details>
            <details><summary className="cursor-pointer text-sm">Response</summary>{result ? <pre className="mt-2 overflow-auto rounded bg-muted p-3 text-xs">{JSON.stringify(response, null, 2)}</pre> : <p className="mt-2 text-sm text-muted-foreground">No response recorded before the test ended.</p>}</details>
          </section>;
        })}
      </>}
  </div>;
}
