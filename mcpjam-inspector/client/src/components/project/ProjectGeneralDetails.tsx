import { SettingsPageDescription } from "@/components/settings/SettingsPageDescription";
import { useState, type ReactNode } from "react";
import { Save } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Textarea } from "@mcpjam/design-system/textarea";
import { useSettingsDraft } from "../settings/SettingsDraftProvider";
export function ProjectGeneralDetails({name, description, canEdit, icon, onSave}: {name:string; description:string; canEdit:boolean; icon:ReactNode; onSave:(details:{name:string;description:string})=>Promise<unknown>}) {
 const [draft,setDraft] = useState<{name:string;description:string}|null>(null);
 const [saving,setSaving] = useState(false); const [error,setError] = useState("");
 const value = draft ?? {name,description}; const dirty = value.name !== name || value.description !== description;
 useSettingsDraft(dirty,()=>{setDraft(null);setError("");},saving);
 return <div className="max-w-2xl space-y-7 text-accent-foreground">
 <header className="space-y-1"><h1 className="text-2xl font-semibold">General</h1><SettingsPageDescription>Manage your project’s name, description, and icon.</SettingsPageDescription></header>
 <div className="flex items-center gap-4 border-b border-border pb-7"><fieldset disabled={!canEdit || saving} className="shrink-0">{icon}</fieldset><div><h2 className="text-sm font-semibold">Project icon</h2><p className="text-xs text-foreground">Choose an icon to identify this project.</p></div></div>
 <form className="space-y-4" onSubmit={async event=>{event.preventDefault();if(!canEdit||saving||!dirty)return;if(!value.name.trim()){setError("Enter a project name.");return;}setSaving(true);setError("");try{await onSave({name:value.name.trim(),description:value.description});setDraft(null);}catch{setError("Could not save project details. Please try again.");}finally{setSaving(false);}}}>
 <div className="space-y-2"><Label htmlFor="project-name">Project name</Label><Input id="project-name" value={value.name} readOnly={!canEdit} disabled={saving} onChange={event=>setDraft({...value,name:event.target.value})}/></div>
 <div className="space-y-2"><Label htmlFor="project-description">Description</Label><Textarea id="project-description" value={value.description} readOnly={!canEdit} disabled={saving} placeholder="Describe this project" onChange={event=>setDraft({...value,description:event.target.value})}/></div>
 {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
 {canEdit ? <Button type="submit" disabled={!dirty||saving}><Save className="size-4" />{saving?"Saving…":"Save changes"}</Button>:<p className="text-xs text-muted-foreground">Only project admins can edit these details.</p>}
 </form></div>;
}
