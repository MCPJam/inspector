import { Badge } from "@mcpjam/design-system/badge";
import { CardHeader } from "@mcpjam/design-system/card";

const TOGGLE_LABEL = "Use your keys for all AI features";

export function DefaultModelCardHeader({
  title,
  locked,
  requireOrgKeys,
}: {
  title: string;
  locked: boolean;
  requireOrgKeys: boolean;
}) {
  return (
    <CardHeader className="px-0">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
          {locked ? (
            <Badge
              variant="secondary"
              className="text-xs uppercase tracking-wide"
              data-testid="org-ai-default-model-enterprise-badge"
            >
              Enterprise
            </Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          Background AI work that nobody picks a model for runs on the
          organization&apos;s default AI model while &ldquo;{TOGGLE_LABEL}&rdquo;
          is on.{" "}
          {requireOrgKeys
            ? "With no default model set, that work is unavailable."
            : "Until then, MCPJam-provided models run it."}{" "}
          Model pickers never use it, and each suite still chooses its own
          judge.
        </p>
      </div>
    </CardHeader>
  );
}
