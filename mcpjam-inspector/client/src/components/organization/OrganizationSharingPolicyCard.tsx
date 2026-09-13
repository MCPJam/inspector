import { Card, CardContent, CardHeader } from "@mcpjam/design-system/card";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import { Switch } from "@mcpjam/design-system/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import {
  useOrgSharePolicy,
  type ShareInviteAudience,
  type ShareMode,
} from "@/hooks/useOrgSharePolicy";

const MODE_OPTIONS: Array<{ value: ShareMode; label: string }> = [
  { value: "anyone_with_link", label: "Anyone with the link" },
  { value: "invited_only", label: "Invited users only" },
  { value: "project_members", label: "Project members" },
];

export function OrganizationSharingPolicyCard({
  organizationId,
  isAdmin,
}: {
  organizationId: string;
  isAdmin: boolean;
}) {
  const { policy, isLoading, error, isSaving, setPolicy } =
    useOrgSharePolicy(organizationId);
  const policyReady = policy !== undefined;
  const disabled = !isAdmin || isSaving || !policyReady;

  const save = async (next: {
    maxShareMode: ShareMode;
    inviteAudience: ShareInviteAudience;
  }) => {
    if (!policyReady) return;
    await setPolicy(next).catch(() => {});
  };

  return (
    <Card
      className="gap-4 border-0 bg-transparent py-0 shadow-none"
      data-testid="org-sharing-policy-card"
    >
      <CardHeader className="px-0">
        <h2 className="text-lg font-semibold text-accent-foreground">
          Sharing
        </h2>
        <p className="text-sm text-muted-foreground">
          Control who can access shared resources and receive invitations.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 p-0">
        {error ? (
          <Alert variant="destructive" data-testid="org-sharing-policy-error">
            <AlertTitle>Couldn&apos;t save sharing policy</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="text-sm font-medium" htmlFor="org-share-max-mode">
            Maximum share access
          </label>
          <Select
            value={policy?.maxShareMode ?? "anyone_with_link"}
            disabled={disabled}
            onValueChange={(value) => {
              if (!policy) return;
              void save({
                maxShareMode: value as ShareMode,
                inviteAudience: policy.inviteAudience,
              });
            }}
          >
            <SelectTrigger
              id="org-share-max-mode"
              data-testid="org-share-max-mode"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">Organization members only</p>
            <p className="text-xs text-muted-foreground">
              Invites can only go to people already in this organization.
            </p>
          </div>
          <Switch
            checked={policy?.inviteAudience === "org_members"}
            disabled={disabled}
            aria-label="Organization members only"
            data-testid="org-share-invite-audience"
            onCheckedChange={(checked) => {
              if (!policy) return;
              void save({
                maxShareMode: policy.maxShareMode,
                inviteAudience: checked ? "org_members" : "anyone",
              });
            }}
          />
        </div>

        {!isAdmin ? (
          <p className="text-xs text-muted-foreground">
            Only organization admins can change these.
          </p>
        ) : null}

        {isLoading ? (
          <p className="text-xs text-muted-foreground">
            Loading sharing policy…
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
