import { AlertCircle } from "lucide-react";
import { CopyableCodeBlock } from "@/components/evals/copyable-code-block";
import { HOSTED_STDIO_ERROR } from "@/lib/server-form-validation";

export function FirstRunValidationNotice({ error }: { error: string }) {
  return (
    <>
      <div
        className="mt-3 flex items-start gap-2.5 rounded-lg border border-destructive/25 bg-destructive/5 p-3"
        role="alert"
      >
        <AlertCircle
          className="mt-0.5 size-4 shrink-0 text-destructive"
          aria-hidden
        />
        <p className="text-[12px] leading-4 font-semibold text-card-foreground">
          {error}
        </p>
      </div>
      {error === HOSTED_STDIO_ERROR ? (
        <section className="mt-3 space-y-2" aria-label="Run MCPJam locally">
          <p className="text-[12px] leading-5 text-foreground">
            Run this command in your terminal, then connect your STDIO server.
          </p>
          <CopyableCodeBlock
            code="npx @mcpjam/inspector@latest"
            copyLabel="Copy MCPJam command"
            toolbarLabel="Run MCPJam locally"
          />
          <p className="text-[11px] leading-4 text-muted-foreground">
            You can also use the MCPJam desktop app.
          </p>
        </section>
      ) : null}
    </>
  );
}
