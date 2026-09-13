import {
  UserRound,
  Palette,
  KeyRound,
  Sparkle,
  Database,
  Info,
  CircleHelp,
  Building2,
  Users,
  Share2,
  Plug,
  BadgeDollarSign,
  DollarSign,
  ScrollText,
  LockKeyhole,
  Settings2,
  type LucideIcon,
} from "lucide-react";

const settingsIcons: Record<string, LucideIcon> = {
  "personal-profile": UserRound,
  "personal-appearance": Palette,
  "personal-api-keys": KeyRound,
  "personal-about": Info,
  "personal-support": CircleHelp,
  "org-general": Building2,
  "org-members": Users,
  "org-sharing": Share2,
  "org-api-keys": KeyRound,
  "org-plans": BadgeDollarSign,
  "org-byok": Sparkle,
  "org-integrations": Plug,
  "org-billing": DollarSign,
  "org-audit-log": ScrollText,
  "org-data-management": Database,
  "project-general": Settings2,
  "project-members": Users,
  "project-secrets": LockKeyhole,
};
export function DestinationIcon({ id }: { id: string }) {
  const Icon = settingsIcons[id] ?? Settings2;
  return <Icon aria-hidden="true" className="size-4 shrink-0" />;
}
