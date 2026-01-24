import { useRef, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { EditableText } from "@/components/ui/editable-text";
import { getInitials } from "@/lib/utils";
import { Camera, Loader2 } from "lucide-react";
import { useProfilePicture } from "@/hooks/useProfilePicture";

export function ProfileTab() {
  const { user, signIn } = useAuth();
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { profilePictureUrl } = useProfilePicture();
  const convexUser = useQuery("users:getCurrentUser" as any);
  const generateUploadUrl = useAction(
    "users:generateProfilePictureUploadUrl" as any,
  );
  const updateProfilePicture = useMutation("users:updateProfilePicture" as any);
  const updateName = useMutation("users:updateName" as any);
  const updateInfo = useMutation("users:updateInfo" as any);

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

  const handleSaveName = async (name: string) => {
    await updateName({ name });
  };

  const handleSaveInfo = async (info: string) => {
    await updateInfo({ info });
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
  const displayName =
    convexUser?.name ||
    [user.firstName, user.lastName].filter(Boolean).join(" ") ||
    "User";
  const initials = getInitials(displayName);
  const avatarUrl = profilePictureUrl;

  return (
    <div className="p-8 max-w-4xl">
      {/* Profile Header - Asana style */}
      <div className="flex items-start gap-6">
        {/* Profile Picture */}
        <div className="relative group shrink-0">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
          />
          <Avatar
            className="h-36 w-36 cursor-pointer"
            onClick={handleAvatarClick}
          >
            <AvatarImage src={avatarUrl} alt={displayName} />
            <AvatarFallback className="bg-primary/10 text-primary text-4xl">
              {initials}
            </AvatarFallback>
          </Avatar>
          {/* Camera Icon Overlay */}
          <button
            onClick={handleAvatarClick}
            disabled={isUploading}
            className="absolute bottom-1 left-1 p-2 bg-background border border-border rounded-full shadow-sm hover:bg-accent transition-colors cursor-pointer"
          >
            {isUploading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <Camera className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
        </div>

        {/* Profile Info */}
        <div className="flex-1 pt-2">
          {/* Editable Name */}
          <EditableText
            value={displayName}
            onSave={handleSaveName}
            className="text-3xl font-semibold -ml-2"
            placeholder="Enter your name"
          />

          {/* Email */}
          <p className="text-muted-foreground mt-1">{user.email}</p>

          {/* About Me */}
          <EditableText
            value={convexUser?.info || ""}
            onSave={handleSaveInfo}
            className="text-muted-foreground -ml-2 mt-3"
            placeholder="About me"
          />
        </div>
      </div>
    </div>
  );
}
