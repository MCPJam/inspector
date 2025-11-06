import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Copy,
  Download,
  Edit2,
  Plus,
  Star,
  StarOff,
  Trash2,
  Upload,
} from "lucide-react";
import { Profile } from "@/state/app-types";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface ProfileManagementDialogProps {
  isOpen: boolean;
  onClose: () => void;
  profiles: Record<string, Profile>;
  activeProfileId: string;
  onCreateProfile: (name: string, description?: string) => void;
  onUpdateProfile: (profileId: string, updates: Partial<Profile>) => void;
  onDeleteProfile: (profileId: string) => void;
  onDuplicateProfile: (profileId: string, newName: string) => void;
  onSetDefaultProfile: (profileId: string) => void;
  onExportProfile: (profileId: string) => void;
  onImportProfile: (profileData: Profile) => void;
}

export function ProfileManagementDialog({
  isOpen,
  onClose,
  profiles,
  activeProfileId,
  onCreateProfile,
  onUpdateProfile,
  onDeleteProfile,
  onDuplicateProfile,
  onSetDefaultProfile,
  onExportProfile,
  onImportProfile,
}: ProfileManagementDialogProps) {
  const [view, setView] = useState<"list" | "create" | "edit">("list");
  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileDescription, setNewProfileDescription] = useState("");
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const profileList = Object.values(profiles).sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    return a.name.localeCompare(b.name);
  });

  const handleCreateProfile = () => {
    if (newProfileName.trim()) {
      onCreateProfile(newProfileName.trim(), newProfileDescription.trim() || undefined);
      setNewProfileName("");
      setNewProfileDescription("");
      setView("list");
    }
  };

  const handleUpdateProfile = () => {
    if (editingProfile && editingProfile.name.trim()) {
      onUpdateProfile(editingProfile.id, {
        name: editingProfile.name.trim(),
        description: editingProfile.description?.trim() || undefined,
      });
      setEditingProfile(null);
      setView("list");
    }
  };

  const handleStartEdit = (profile: Profile) => {
    setEditingProfile({ ...profile });
    setView("edit");
  };

  const handleDeleteClick = (profileId: string) => {
    setDeleteConfirmId(profileId);
  };

  const handleConfirmDelete = () => {
    if (deleteConfirmId) {
      onDeleteProfile(deleteConfirmId);
      setDeleteConfirmId(null);
    }
  };

  const handleDuplicate = (profile: Profile) => {
    const newName = `${profile.name} (Copy)`;
    onDuplicateProfile(profile.id, newName);
  };

  const handleImport = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        try {
          const text = await file.text();
          const profileData = JSON.parse(text);
          onImportProfile(profileData);
        } catch (error) {
          console.error("Failed to import profile:", error);
          alert("Failed to import profile. Please check the file format.");
        }
      }
    };
    input.click();
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Manage Profiles</DialogTitle>
            <DialogDescription>
              Create, edit, and manage your MCP server profiles
            </DialogDescription>
          </DialogHeader>

          {view === "list" && (
            <div className="flex flex-col gap-4 flex-1 overflow-hidden">
              <div className="flex gap-2">
                <Button
                  onClick={() => setView("create")}
                  className="flex-1"
                  variant="default"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Create Profile
                </Button>
                <Button onClick={handleImport} variant="outline">
                  <Upload className="h-4 w-4 mr-2" />
                  Import
                </Button>
              </div>

              <ScrollArea className="flex-1">
                <div className="space-y-2 pr-4">
                  {profileList.map((profile) => (
                    <div
                      key={profile.id}
                      className="p-4 border rounded-lg hover:bg-accent/50 transition-colors"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="font-semibold truncate">
                              {profile.name}
                            </h3>
                            {profile.id === activeProfileId && (
                              <Badge variant="default" className="text-xs">
                                Active
                              </Badge>
                            )}
                            {profile.isDefault && (
                              <Badge variant="secondary" className="text-xs">
                                Default
                              </Badge>
                            )}
                          </div>
                          {profile.description && (
                            <p className="text-sm text-muted-foreground truncate">
                              {profile.description}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground mt-1">
                            {Object.keys(profile.servers).length} server(s)
                          </p>
                        </div>

                        <div className="flex gap-1 ml-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() =>
                              onSetDefaultProfile(profile.id)
                            }
                            title={
                              profile.isDefault
                                ? "Unset as default"
                                : "Set as default"
                            }
                          >
                            {profile.isDefault ? (
                              <Star className="h-4 w-4 fill-current" />
                            ) : (
                              <StarOff className="h-4 w-4" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleStartEdit(profile)}
                            title="Edit profile"
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDuplicate(profile)}
                            title="Duplicate profile"
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => onExportProfile(profile.id)}
                            title="Export profile"
                          >
                            <Download className="h-4 w-4" />
                          </Button>
                          {profile.id !== activeProfileId && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleDeleteClick(profile.id)}
                              title="Delete profile"
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}

          {view === "create" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="profile-name">Profile Name *</Label>
                <Input
                  id="profile-name"
                  value={newProfileName}
                  onChange={(e) => setNewProfileName(e.target.value)}
                  placeholder="e.g., Work, Personal, Development"
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="profile-description">Description</Label>
                <Textarea
                  id="profile-description"
                  value={newProfileDescription}
                  onChange={(e) => setNewProfileDescription(e.target.value)}
                  placeholder="Optional description for this profile"
                  rows={3}
                />
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setView("list")}>
                  Cancel
                </Button>
                <Button
                  onClick={handleCreateProfile}
                  disabled={!newProfileName.trim()}
                >
                  Create
                </Button>
              </div>
            </div>
          )}

          {view === "edit" && editingProfile && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-profile-name">Profile Name *</Label>
                <Input
                  id="edit-profile-name"
                  value={editingProfile.name}
                  onChange={(e) =>
                    setEditingProfile({
                      ...editingProfile,
                      name: e.target.value,
                    })
                  }
                  placeholder="Profile name"
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-profile-description">Description</Label>
                <Textarea
                  id="edit-profile-description"
                  value={editingProfile.description || ""}
                  onChange={(e) =>
                    setEditingProfile({
                      ...editingProfile,
                      description: e.target.value,
                    })
                  }
                  placeholder="Optional description"
                  rows={3}
                />
              </div>
              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditingProfile(null);
                    setView("list");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleUpdateProfile}
                  disabled={!editingProfile.name.trim()}
                >
                  Save Changes
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteConfirmId !== null}
        onOpenChange={() => setDeleteConfirmId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Profile?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the profile and all its server
              configurations. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
