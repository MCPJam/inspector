import { SettingsPageDescription } from "@/components/settings/SettingsPageDescription";
import { LockKeyhole } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
export const enterpriseContactHref = "https://www.mcpjam.com/contact";
export function DataManagementSettings({
  enterprise,
}: {
  enterprise: boolean;
}) {
  return (
    <section className="space-y-8">
      <header className="space-y-2">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Data management</h1>
          <Badge variant="secondary">ENTERPRISE</Badge>
        </div>
        <SettingsPageDescription>
          Manage your organization’s data retention requirements across
          projects.
        </SettingsPageDescription>
      </header>
      <div className="flex min-h-56 flex-col items-center justify-center gap-5 rounded-lg border border-border bg-muted/20 p-6 text-center">
        <LockKeyhole
          aria-hidden="true"
          className="size-7 text-muted-foreground"
        />
        <p className="text-muted-foreground">
          {enterprise
            ? "Contact us to configure your organization’s retention policy."
            : "Custom data retention is available with Enterprise."}
        </p>
        <Button asChild>
          <a href={enterpriseContactHref}>Contact us</a>
        </Button>
      </div>
    </section>
  );
}
