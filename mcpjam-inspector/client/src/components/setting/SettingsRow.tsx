import { ReactNode } from "react";

interface SettingsRowProps {
  label: string;
  value?: ReactNode;
}

export function SettingsRow({ label, value }: SettingsRowProps) {
  return (
    <div className="flex items-center justify-between px-4 py-3 rounded-md border border-border/40">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  );
}
