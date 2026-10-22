import { Button } from "@mcpjam/design-system/button";
import type { AiRefusalCode } from "@/shared/ai-execution-refusal";
import { useOrgAiRefusalHandoff } from "@/contexts/org-ai-refusal-context";
import { ASK_ORG_ADMIN, MANAGE_AI_PROVIDERS } from "@/lib/org-keys-refusal";
import { describeWebSearchRefusal } from "@/lib/web-search-refusal";

/** Refusals a member can't fix but an organization admin can. */
const ADMIN_FIXES = new Set([
  "choose_org_model",
  "add_org_provider",
  "configure_org_model_role",
  "fix_org_credentials",
]);

/**
 * Why a web search was refused under the organization's AI key policy, on
 * the tool card itself so it shows without expanding the card. An admin gets
 * the way to Organization → AI providers; a member is told to ask one when an
 * admin can fix it; a visitor reads one neutral sentence.
 */
export function WebSearchRefusalNotice({ code }: { code: AiRefusalCode }) {
  const { audience, onManageOrgProviders } = useOrgAiRefusalHandoff();
  const canManage = audience === "admin" && !!onManageOrgProviders;
  const described = describeWebSearchRefusal(
    code,
    canManage ? "admin" : audience === "visitor" ? "visitor" : "member",
  );
  const askAdmin =
    !canManage &&
    audience !== "visitor" &&
    ADMIN_FIXES.has(described.remediation) &&
    !/organization admin/i.test(described.body);
  return (
    <div className="px-3 pb-3">
      <div
        role="status"
        data-testid="web-search-refusal"
        data-refusal-code={code}
        className="flex flex-wrap items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-foreground"
      >
        <div className="min-w-0 grow basis-56">
          <p className="text-xs font-medium leading-5">{described.title}</p>
          <p className="text-xs leading-5 text-muted-foreground">
            {described.body}
            {askAdmin ? ` ${ASK_ORG_ADMIN}.` : null}
          </p>
        </div>
        {canManage ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={(event) => {
              event.stopPropagation();
              onManageOrgProviders?.();
            }}
          >
            {MANAGE_AI_PROVIDERS}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
