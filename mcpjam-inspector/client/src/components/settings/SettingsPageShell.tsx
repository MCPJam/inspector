import type { ReactNode } from "react";
import { SettingsNav, type SettingsNavSection } from "./SettingsNav";

interface SettingsPageShellProps {
  active: SettingsNavSection;
  activeOrganizationId?: string | null;
  children: ReactNode;
}

/**
 * Frame shared by every Settings section, including the organization page.
 *
 * The section nav is persistent navigation, so it has to land on the same
 * pixels on all four routes. Each page used to own its container: `/settings/*`
 * rendered a left-aligned `max-w-3xl` column with `p-10`, while the org page
 * rendered a centered `max-w-5xl` column with `p-4`, so clicking Organization
 * moved the strip you had just clicked and dropped the page heading with it.
 */
export function SettingsPageShell({
  active,
  activeOrganizationId,
  children,
}: SettingsPageShellProps) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-8 p-10">
        <div className="space-y-4">
          <h1 className="text-2xl font-semibold">Settings</h1>
          <SettingsNav
            active={active}
            activeOrganizationId={activeOrganizationId}
          />
        </div>

        {children}
      </div>
    </div>
  );
}
