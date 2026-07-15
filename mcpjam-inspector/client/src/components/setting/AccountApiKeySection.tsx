type AccountApiKeySectionProps = {
  projectId: string | null;
  projectName: string | null;
};

/**
 * Project API keys (`mcpjam_…`) are retired. The backend rejects every
 * existing key and refuses to mint new ones (mcpjam-backend
 * convex/apiKeys.ts), so this section no longer offers generate/rotate —
 * it only explains where to go instead. Kept (rather than deleted) for a
 * release or two so users whose CI broke can find out why from the place
 * the key came from.
 */
export function AccountApiKeySection({
  projectName,
}: AccountApiKeySectionProps) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3 rounded-md border border-border/40">
      <span className="text-sm text-muted-foreground">
        Project API Key
        {projectName ? ` · ${projectName}` : ""}
      </span>
      <span className="text-muted-foreground text-xs">
        Retired — project API keys (mcpjam_…) no longer work and can no longer
        be generated. Everything they did now runs on MCPJam API keys (sk_…)
        from Settings → API keys, including saving SDK eval results: set
        MCPJAM_API_KEY to an sk_… key and reports land in this project&apos;s
        Evals dashboard.
      </span>
    </div>
  );
}
