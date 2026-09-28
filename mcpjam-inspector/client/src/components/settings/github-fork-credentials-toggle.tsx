import { useEffect, useRef, useState } from "react";
import { Switch } from "@mcpjam/design-system/switch";
import { toast } from "@/lib/toast";
import { githubChecksWriteErrorMessage } from "@/lib/github-checks-errors";
import type { GithubCheckRepoConfigRow } from "@/hooks/useGithubChecksSettings";

export function GithubForkCredentialsToggle({
  row,
  canManage,
  onChange,
}: {
  row: GithubCheckRepoConfigRow;
  canManage: boolean;
  onChange: (args: {
    configId: string;
    enabled: boolean;
  }) => Promise<{ changed: boolean }>;
}) {
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const noteId = `fork-credentials-note-${row._id}`;
  return (
    <div className="space-y-1">
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={row.allowSuiteCredentialsInForks === true}
          disabled={
            pending ||
            !canManage ||
            (row.allowSuiteCredentialsInForks !== true &&
              (!row.enabled || row.connectionStatus !== "verified"))
          }
          aria-label={`Allow suite credentials in approved forks for ${row.repoFullName}`}
          aria-describedby={noteId}
          onCheckedChange={async (enabled) => {
            if (pending) return;
            setPending(true);
            try {
              await onChange({ configId: row._id, enabled });
            } catch (error) {
              if (mounted.current)
                toast.error(githubChecksWriteErrorMessage(error));
            } finally {
              if (mounted.current) setPending(false);
            }
          }}
        />
        Allow suite credentials in approved forks
      </label>
      <p id={noteId} className="text-xs text-muted-foreground">
        Approved fork runs can use this suite’s credentials and connected
        services. Only approve code you trust.
      </p>
    </div>
  );
}
