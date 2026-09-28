import { useAppNavigate } from "@/lib/app-navigation";
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
  const navigate = useAppNavigate();
  return (
    <div className="flex flex-col gap-1 px-4 py-3 rounded-md border border-border/40">
      <span className="text-sm text-muted-foreground">
        Project API Key
        {projectName ? ` · ${projectName}` : ""}
      </span>
      <span className="text-muted-foreground text-xs">
        Project API keys are retired. Use a personal API key for SDK and CI
        access.
      </span>
      <a
        href="/settings/api-keys"
        className="self-start text-sm text-primary underline underline-offset-4 hover:text-primary/80"
        onClick={(event) => {
          if (
            event.button === 0 &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey
          ) {
            event.preventDefault();
            navigate("/settings/api-keys");
          }
        }}
      >
        Manage API keys
      </a>
    </div>
  );
}
