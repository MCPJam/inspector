import { Globe, Monitor, Terminal } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";

export function WebmcpInstallPage() {
  return (
    <div className="flex h-full overflow-auto p-6">
      <section
        className="m-auto w-full max-w-xl shrink-0 space-y-8"
        aria-labelledby="webmcp-install-title"
      >
        <div className="space-y-3">
          <Globe className="size-8 text-foreground" aria-hidden="true" />
          <h1 id="webmcp-install-title" className="text-2xl font-semibold">
            Use WebMCP on your computer
          </h1>
          <p className="text-sm text-foreground">
            Inspect and test the WebMCP tools exposed by your web pages. Launch
            MCPJam locally with Node.js or the desktop app to get started.
          </p>
        </div>
        <div className="space-y-4 rounded-lg border border-border p-5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Terminal className="size-4" aria-hidden="true" /> Run with Node.js
          </h2>
          <p className="text-sm">
            With Node.js 22 or later, run this in your terminal:
          </p>
          <pre className="overflow-x-auto rounded-md bg-[var(--code-bg)] p-3 text-sm text-[var(--code-text)]">
            <code>npx @mcpjam/inspector@latest</code>
          </pre>
          <Button asChild variant="outline">
            <a
              href="https://docs.mcpjam.com/installation#terminal"
              target="_blank"
              rel="noopener noreferrer"
            >
              Node.js installation guide
            </a>
          </Button>
        </div>
        <div className="space-y-4 rounded-lg border border-border p-5">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Monitor className="size-4" aria-hidden="true" /> Get the desktop
            app
          </h2>
          <p className="text-sm">
            Install MCPJam on your computer. No Node.js setup required.
          </p>
          <Button asChild variant="outline">
            <a
              href="https://github.com/MCPJam/inspector/releases/latest"
              target="_blank"
              rel="noopener noreferrer"
            >
              Download the desktop app
            </a>
          </Button>
        </div>
      </section>
    </div>
  );
}
