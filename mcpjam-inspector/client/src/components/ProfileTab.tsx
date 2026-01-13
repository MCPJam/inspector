import { useRef, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getInitials } from "@/lib/utils";
import { Mail, Calendar, Camera, Loader2, Pencil, Check, X } from "lucide-react";
import { useProfilePicture } from "@/hooks/useProfilePicture";

export function ProfileTab() {
  const { user, signIn } = useAuth();
  const [isUploading, setIsUploading] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState("");
  const [isSavingName, setIsSavingName] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { profilePictureUrl } = useProfilePicture();
  const convexUser = useQuery("users:getCurrentUser" as any);
  const generateUploadUrl = useAction("users:generateProfilePictureUploadUrl" as any);
  const updateProfilePicture = useMutation("users:updateProfilePicture" as any);
  const updateName = useMutation("users:updateName" as any);

  const handleAvatarClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith("image/")) {
      alert("Please select an image file");
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      alert("Image must be less than 5MB");
      return;
    }

    setIsUploading(true);

    try {
      // Get upload URL from Convex
      const uploadUrl = await generateUploadUrl();

      // Upload file to Convex storage
      const result = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });

      if (!result.ok) {
        throw new Error("Failed to upload file");
      }

      const { storageId } = await result.json();

      // Update user's profile picture in database
      await updateProfilePicture({ storageId });
    } catch (error) {
      console.error("Failed to upload profile picture:", error);
      alert("Failed to upload profile picture. Please try again.");
    } finally {
      setIsUploading(false);
    }
  };

  const handleStartEditName = () => {
    const currentName = convexUser?.name || [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "";
    setEditedName(currentName);
    setIsEditingName(true);
  };

  const handleCancelEditName = () => {
    setIsEditingName(false);
    setEditedName("");
  };

  const handleSaveName = async () => {
    if (!editedName.trim()) return;

    setIsSavingName(true);
    try {
      await updateName({ name: editedName.trim() });
      setIsEditingName(false);
      setEditedName("");
    } catch (error) {
      console.error("Failed to update name:", error);
      alert("Failed to update name. Please try again.");
    } finally {
      setIsSavingName(false);
    }
  };

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <div className="text-center space-y-4 max-w-md">
          <h2 className="text-2xl font-bold">Sign in to view your profile</h2>
          <Button onClick={() => signIn()} size="lg">
            Sign In
          </Button>
        </div>
      </div>
    );
  }

  // Prefer convexUser name (can be edited) over WorkOS user name
  const displayName = convexUser?.name || [user.firstName, user.lastName].filter(Boolean).join(" ") || "User";
  const initials = getInitials(displayName);
  const avatarUrl = profilePictureUrl;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Profile Header */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-start gap-6">
            {/* Editable Profile Picture */}
            <div className="relative group">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFileChange}
              />
              <Avatar
                className="h-28 w-28 cursor-pointer ring-4 ring-background shadow-lg"
                onClick={handleAvatarClick}
              >
                <AvatarImage src={avatarUrl} alt={displayName} />
                <AvatarFallback className="bg-primary/10 text-primary text-3xl">
                  {initials}
                </AvatarFallback>
              </Avatar>
              {/* Camera Icon Overlay */}
              <button
                onClick={handleAvatarClick}
                disabled={isUploading}
                className="absolute bottom-0 left-0 p-1.5 bg-muted border border-border rounded-full shadow-sm hover:bg-accent transition-colors cursor-pointer"
              >
                {isUploading ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  <Camera className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
            </div>
            <div className="flex-1">
              {/* Editable Name */}
              {isEditingName ? (
                <div className="flex items-center gap-2">
                  <Input
                    value={editedName}
                    onChange={(e) => setEditedName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSaveName();
                      if (e.key === "Escape") handleCancelEditName();
                    }}
                    className="text-xl font-bold h-9 max-w-xs"
                    autoFocus
                    disabled={isSavingName}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleSaveName}
                    disabled={isSavingName || !editedName.trim()}
                    className="h-8 w-8 p-0"
                  >
                    {isSavingName ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="h-4 w-4 text-green-600" />
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleCancelEditName}
                    disabled={isSavingName}
                    className="h-8 w-8 p-0"
                  >
                    <X className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2 group">
                  <h1 className="text-2xl font-bold">{displayName}</h1>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleStartEditName}
                    className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Pencil className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </div>
              )}
              <div className="flex items-center gap-2 mt-2 text-muted-foreground">
                <Mail className="w-4 h-4" />
                <span>{user.email}</span>
              </div>
              {user.createdAt && (
                <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
                  <Calendar className="w-4 h-4" />
                  <span>
                    Joined {new Date(user.createdAt).toLocaleDateString()}
                  </span>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
