import { Switch } from "@mcpjam/design-system/switch";

/**
 * Whether the client declares `io.modelcontextprotocol/ui` while it renders
 * MCP Apps. Off keeps views rendering without the declaration
 * (`mcpProfile.appsViewRendering: "always"`), which is how some real hosts
 * behave, so a server that checks the declaration is tested against them.
 * Inert while the host renders no Apps at all.
 */
export function AppsExtensionDeclarationRow({
  rendered,
  declared,
  onDeclaredChange,
}: {
  rendered: boolean;
  declared: boolean;
  onDeclaredChange: (next: boolean) => void;
}) {
  return (
    <div
      data-testid="mcp-apps-extension-declaration"
      className="flex items-center justify-between gap-3 border-b border-border/50 px-3.5 py-2"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[12px]">
          Declares <span className="font-mono">io.modelcontextprotocol/ui</span>
        </span>
        <p className="text-[11px] leading-snug text-muted-foreground">
          Turn off to render MCP Apps without declaring the extension, as
          Gemini and Le Chat do. Servers that check for it send text instead.
        </p>
      </div>
      <Switch
        checked={rendered && declared}
        disabled={!rendered}
        onCheckedChange={onDeclaredChange}
        aria-label="Declares io.modelcontextprotocol/ui"
      />
    </div>
  );
}
