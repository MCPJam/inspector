import { SettingsPageDescription } from "@/components/settings/SettingsPageDescription";
import { LockKeyhole, ShieldCheck } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@mcpjam/design-system/dialog";
export const enterpriseContactHref = "https://www.mcpjam.com/contact";
export function DataManagementSettings({ enterprise }: { enterprise: boolean }) {
 return <section className="space-y-8">
  <header className="space-y-2"><div className="flex items-center gap-3"><h1 className="text-2xl font-semibold">Data management</h1><Badge variant="secondary">ENTERPRISE</Badge></div><SettingsPageDescription>Manage your organization’s data retention requirements across projects.</SettingsPageDescription></header>
  <div className="flex min-h-56 flex-col items-center justify-center gap-5 rounded-lg border border-border bg-muted/20 p-6 text-center">
   <LockKeyhole aria-hidden="true" className="size-7 text-muted-foreground" />
   <p className="text-muted-foreground">{enterprise ? "Contact us to configure your organization’s retention policy." : "Custom data retention is available with Enterprise."}</p>
   <Button asChild><a href={enterpriseContactHref}>Contact us</a></Button>
  </div>
 </section>;
}
export function PermissionGroupsDialog({ enterprise }: { enterprise: boolean }) {
 return <Dialog><DialogTrigger asChild><Button variant="outline" size="sm"><ShieldCheck className="size-4" />Permission groups<Badge variant="secondary" className="text-[10px]">ENTERPRISE</Badge></Button></DialogTrigger>
 <DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>{enterprise ? "Custom permission groups" : "Access custom permission groups with Enterprise"}</DialogTitle><DialogDescription>Talk with us about your organization’s access-control requirements and a tailored Enterprise setup.</DialogDescription></DialogHeader>
 <div className="grid gap-4 py-4 sm:grid-cols-2"><div><ShieldCheck aria-hidden="true" className="mb-2 size-5 text-primary" /><h3 className="font-medium">Permission groups</h3><p className="mt-1 text-sm text-muted-foreground">Discuss roles and access policies for your teams.</p></div><div><LockKeyhole aria-hidden="true" className="mb-2 size-5 text-primary" /><h3 className="font-medium">Enterprise support</h3><p className="mt-1 text-sm text-muted-foreground">Plan your security and data-management requirements with us.</p></div></div>
 <DialogFooter><DialogClose asChild><Button variant="outline">Dismiss</Button></DialogClose><Button asChild><a href={enterpriseContactHref}>Contact us</a></Button></DialogFooter></DialogContent></Dialog>;
}
