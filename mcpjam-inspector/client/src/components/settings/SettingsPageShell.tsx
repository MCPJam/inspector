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
 * pixels on every route. Each page used to own its container — `/settings/*`
 * a left-aligned `max-w-3xl` column, the org page a centered `max-w-5xl` one
 * with different padding and no heading — so clicking Organization moved the
 * strip you had just clicked and dropped the page heading with it.
 */
export function SettingsPageShell({
  active,
  activeOrganizationId,
  children,
}: SettingsPageShellProps) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-8 p-4 md:p-10">
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
