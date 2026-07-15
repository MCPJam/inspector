import { useConvexAuth } from "convex/react";
import { ArrowLeft, Eye } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { SegmentedControl } from "@/components/ui/json-editor/segmented-control";
import { useOrganizationQueries } from "@/hooks/useOrganizations";
import {
  buildXaaSetupPath,
  routePaths,
  useAppNavigate,
  useXaaSetupSection,
  type XaaSetupSection,
} from "@/lib/app-navigation";
import { HOSTED_MODE } from "@/lib/config";
import { MCPJamAgentCard } from "./MCPJamAgentCard";
import { XAASetupAppsSection } from "./XAASetupAppsSection";
import { XAASetupPeopleSection } from "./XAASetupPeopleSection";

const SECTION_OPTIONS: { value: XaaSetupSection; label: string }[] = [
  { value: "people", label: "People" },
  { value: "apps", label: "Servers" },
];

/**
 * Setup center for the managed test IdP (`/xaa-flow/setup`): org People, the
 * fixed MCPJam Agent, and one consolidated server list — a people × servers
 * access matrix (registration + connection + assignments per row; scope
 * details behind each row's "Advanced access" disclosure). Sections are URL
 * segments so each is deep-linkable (the servers section keeps the `apps`
 * segment for old links). Org admins (owner/admin/creator — mirrors
 * XAAResourceAppsSection) manage; everyone else gets a read-only view with
 * locked affordances.
 */
export function XAASetupPage({
  organizationId,
}: {
  organizationId: string | null;
}) {
  const { isAuthenticated: isConvexAuthenticated } = useConvexAuth();
  const { sortedOrganizations } = useOrganizationQueries({
    isAuthenticated: isConvexAuthenticated,
  });
  const section = useXaaSetupSection();
  const navigate = useAppNavigate();

  const activeOrg = sortedOrganizations.find((o) => o._id === organizationId);
  const canManage =
    activeOrg?.myRole === "owner" ||
    activeOrg?.myRole === "admin" ||
    activeOrg?.isCreator === true;

  if (!HOSTED_MODE || !organizationId || !isConvexAuthenticated) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        The XAA setup center is available on app.mcpjam.com when you&apos;re
        signed in with an active organization.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-background">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Back to debugger"
          onClick={() => navigate(routePaths.xaaFlow)}
        >
          <ArrowLeft className="mr-1 h-3.5 w-3.5" />
          Debugger
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">XAA setup</h2>
          <p className="truncate text-xs text-muted-foreground">
            Manage who your test IdP lets the MCPJam Agent act as, per
            server.
          </p>
        </div>
        {!canManage && (
          <Badge
            variant="outline"
            className="gap-1 text-[10px] text-muted-foreground"
            title="Only organization admins can make changes here."
          >
            <Eye className="h-3 w-3" />
            Read-only
          </Badge>
        )}
      </div>

      <MCPJamAgentCard organizationId={organizationId} />

      <div className="flex shrink-0 items-center justify-center px-4 py-2">
        <SegmentedControl
          value={section}
          onChange={(value) =>
            navigate(buildXaaSetupPath(value as XaaSetupSection))
          }
          options={SECTION_OPTIONS}
        />
      </div>

      <div className="min-h-0 flex-1 px-4 pb-4">
        {section === "people" ? (
          <XAASetupPeopleSection
            organizationId={organizationId}
            canManage={canManage}
          />
        ) : (
          <XAASetupAppsSection
            organizationId={organizationId}
            canManage={canManage}
          />
        )}
      </div>
    </div>
  );
}
