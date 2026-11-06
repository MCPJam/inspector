import { TriangleAlert } from "lucide-react";
import { CopyableCodeBlock } from "@/components/evals/copyable-code-block";
import type { FirstRunValidationKind } from "@/lib/server-form-validation";

export function FirstRunValidationNotice({
  error,
  kind = "input",
}: {
  error: string;
  kind?: FirstRunValidationKind;
}) {
  return (
    <>
      <div
        className="mt-3 flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/10 p-3"
        role="alert"
      >
        <TriangleAlert
          className="mt-0.5 size-4 shrink-0 text-foreground"
          aria-hidden
        />
        <p className="text-[12px] leading-4 font-semibold text-card-foreground">
          {error}
        </p>
      </div>
      {kind === "hosted-stdio" ? (
        <section className="mt-3 space-y-2" aria-label="Run MCPJam locally">
          <p className="text-[12px] leading-5 text-foreground">
            Run this command to open MCPJam on your computer, then add your
            server.
          </p>
          <CopyableCodeBlock
            code="npx @mcpjam/inspector@latest"
            copyLabel="Copy MCPJam command"
          />
          <p className="text-[11px] leading-4 text-muted-foreground">
            You can also{" "}
            <a
              href="https://docs.mcpjam.com/installation"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              install the desktop app or run MCPJam with Docker
            </a>
            .
          </p>
        </section>
      ) : null}
    </>
  );
}
