import { Button } from "@mcpjam/design-system/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import type { GithubCheckRepoConfigRow } from "@/hooks/useGithubChecksSettings";

export function GithubPrServerOAuthControl({
  row,
  canManage,
  pending,
  onChange,
  onManage,
}: {
  row: GithubCheckRepoConfigRow;
  canManage: boolean;
  pending: boolean;
  onChange: (sourceServerId: string) => void;
  onManage: () => void;
}) {
  const resolution = row.prServerOAuth;
  if (resolution.status === "not_configured" || resolution.status === "ready") {
    return null;
  }

  if (
    resolution.status === "authorization_required" ||
    resolution.status === "reauthorization_required"
  ) {
    const reconnect = resolution.status === "reauthorization_required";
    return (
      <div className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-3 text-sm">
        <span className="text-muted-foreground">
          {reconnect ? "Reconnect" : "Authorize"}{" "}
          {resolution.sourceName ?? "this suite connection"} for PR checks.
        </span>
        <Button
          variant="link"
          size="sm"
          disabled={!canManage}
          onClick={onManage}
        >
          {reconnect ? "Reconnect" : "Authorize"}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-border/40 pt-3">
      <span className="text-sm text-muted-foreground">
        Choose which suite authorization PR checks should use.
      </span>
      <Select
        value={resolution.sourceServerId}
        disabled={pending || !canManage}
        onValueChange={onChange}
      >
        <SelectTrigger
          className="w-60"
          aria-label={`Server authorization for ${row.repoFullName}`}
        >
          <SelectValue placeholder="Choose authorization" />
        </SelectTrigger>
        <SelectContent>
          {resolution.sources.map((source) => (
            <SelectItem
              key={source.serverId}
              value={source.serverId}
              disabled={!source.authorized}
            >
              {source.name}
              {source.authorized ? "" : " — authorize first"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button variant="link" size="sm" disabled={!canManage} onClick={onManage}>
        Manage authorizations
      </Button>
    </div>
  );
}
