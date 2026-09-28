import { createContext, useContext, type ReactNode } from "react";
import { SettingsContentFrame } from "./SettingsBreadcrumbs";
const InsideSettingsPage = createContext(false);

interface SettingsPageShellProps {
  children: ReactNode;
}

/** Content frame; navigation belongs to the persistent app-level settings rail. */
export function SettingsPageShell({ children }: SettingsPageShellProps) {
  const nested = useContext(InsideSettingsPage);
  if (nested) return <>{children}</>;
  return (
    <InsideSettingsPage.Provider value={true}>
      <SettingsContentFrame>{children}</SettingsContentFrame>
    </InsideSettingsPage.Provider>
  );
}
