import { classifyDeclaredDomain } from "./origin-finding";

interface OriginCardProps {
  declaredDomain?: string | null;
  assignedOrigin?: string;
}

/**
 * The `_meta.ui.domain` reading, rendered outside the blocked-request list.
 *
 * It is not a `Diagnosis`: that type means "the browser refused a request",
 * and the surfaces built on it (the blocked-requests meter, the Policy Diff
 * "observed" column, the copy-a-CSP-patch button) would all misdescribe a
 * declaration mismatch.
 */
export function OriginCard({
  declaredDomain,
  assignedOrigin,
}: OriginCardProps) {
  const kind = classifyDeclaredDomain(declaredDomain, assignedOrigin);
  if (!kind) return null;

  const tone =
    kind === "malformed"
      ? "border-amber-500/40 bg-amber-500/5"
      : "border-border/40 bg-card";

  return (
    <div className={`rounded-md border p-3.5 ${tone}`}>
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-[12.5px] font-medium">Declared view domain</span>
        <span className="font-mono text-[10.5px] text-muted-foreground">
          _meta.ui.domain
        </span>
      </div>
      <div className="font-mono text-[11.5px] break-all mb-2">
        {declaredDomain}
      </div>
      <p className="text-[11.5px] text-muted-foreground leading-relaxed">
        {kind === "malformed" ? (
          <>
            This is not a bare hostname. Hosts expect a domain like{" "}
            <code className="font-mono">abc123.claudemcpcontent.com</code> — no
            scheme, path or port.
          </>
        ) : kind === "match" ? (
          <>
            Matches the origin MCPJam serves this view from
            {assignedOrigin ? (
              <>
                {" "}
                (<code className="font-mono">{assignedOrigin}</code>)
              </>
            ) : null}
            .
          </>
        ) : (
          <>
            MCPJam serves this view from{" "}
            <code className="font-mono">
              {assignedOrigin ?? "a different origin"}
            </code>
            , so an allowlist keyed on the declared domain — an API key
            restriction, an OAuth redirect URI — will not match requests from
            here. That is expected if the value targets another host: MCPJam
            assigns one origin per server, like Claude, while ChatGPT assigns
            one per plugin.
          </>
        )}
      </p>
    </div>
  );
}
