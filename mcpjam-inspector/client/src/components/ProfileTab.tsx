import { SettingsPageDescription } from "@/components/settings/SettingsPageDescription";
import { SettingsPageShell } from "./settings/SettingsPageShell";
import { useSettingsDraft } from "./settings/SettingsDraftProvider";
import { useRef, useState } from "react";
import { permalinkSignInOptions } from "@/lib/permalink-signin-return";
import { useAuth } from "@workos-inc/authkit-react";
import { useMutation, useQuery } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@mcpjam/design-system/avatar";
import { Input } from "@mcpjam/design-system/input";
import { Textarea } from "@mcpjam/design-system/textarea";
import { Label } from "@mcpjam/design-system/label";
import { getInitials } from "@/lib/utils";
import { captureAppSignInReturnPath } from "@/lib/app-signin-return-path";
import { Camera, Loader2, Save, LogIn, LockKeyhole } from "lucide-react";
import { useProfilePicture } from "@/hooks/useProfilePicture";
import { useImageUpload } from "@/hooks/useImageUpload";
import {
  IMAGE_UPLOAD_ACCEPT,
  ImageUploadError,
  validateImageFile,
} from "@/lib/image-upload";

export function ProfileTab() {
  const { user, signIn } = useAuth();
  const [isUploading, setIsUploading] = useState(false);
  const [photoError, setPhotoError] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  const { profilePictureUrl } = useProfilePicture();
  const convexUser = useQuery("users:getCurrentUser" as any);
  const uploadImage = useImageUpload();
  const updateName = useMutation("users:updateName" as any);
  const updateInfo = useMutation("users:updateInfo" as any);

  const handleAvatarClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const problem = validateImageFile(file);
    if (problem) {
      setPhotoError(problem);
      return;
    }

    setPhotoError("");
    setIsUploading(true);

    try {
      // The backend checks the bytes, stores them and sets the picture; the
      // profile query updates on its own.
      await uploadImage({ kind: "profile-picture" }, file);
    } catch (error) {
      console.error("Failed to upload profile picture:", error);
      setPhotoError(
        error instanceof ImageUploadError
          ? error.message
          : "Your profile picture could not be updated. Try uploading it again.",
      );
    } finally {
      setIsUploading(false);
      // Let the same file be picked again after a failure.
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const displayName =
    convexUser?.name ||
    [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
    "User";
  const savedInfo = convexUser?.info || "";
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [infoDraft, setInfoDraft] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);
  const name = nameDraft ?? displayName;
  const info = infoDraft ?? savedInfo;
  const dirty = name !== displayName || info !== savedInfo;
  useSettingsDraft(
    dirty,
    () => {
      setNameDraft(null);
      setInfoDraft(null);
      setSaveError("");
    },
    isSaving || isUploading,
  );
  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSaving || isUploading || !dirty) return;
    setSaved(false);
    if (!name.trim()) {
      setSaveError("Enter your name.");
      return;
    }
    setIsSaving(true);
    setSaveError("");
    try {
      if (name !== displayName) {
        await updateName({ name: name.trim() });
        setNameDraft(null);
      }
      if (info !== savedInfo) {
        await updateInfo({ info });
        setInfoDraft(null);
      }
      setSaved(true);
    } catch {
      setSaveError("Could not save your changes. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  if (!user) {
    return (
      <SettingsPageShell>
        <div className="flex flex-col items-center justify-center p-8">
          <div className="text-center space-y-4 max-w-md">
            <h2 className="text-2xl font-bold">Sign in to view your profile</h2>
            <Button
              onClick={() => {
                // Remember where they were, so WorkOS returns them here rather
                // than to the app's front door.
                captureAppSignInReturnPath();
                signIn(permalinkSignInOptions());
              }}
              size="lg"
            >
              <LogIn aria-hidden="true" className="size-4" />
              Sign In
            </Button>
          </div>
        </div>
      </SettingsPageShell>
    );
  }

  return (
    <SettingsPageShell>
      <div className="max-w-2xl space-y-7 text-accent-foreground">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold">Profile</h1>
          <SettingsPageDescription>
            Manage your photo and personal details.
          </SettingsPageDescription>
        </header>
        <div className="flex items-center gap-4 border-b border-border pb-7">
          <input
            ref={fileInputRef}
            type="file"
            accept={IMAGE_UPLOAD_ACCEPT}
            className="hidden"
            onChange={handleFileChange}
          />
          <Avatar className="size-20 shrink-0">
            <AvatarImage src={profilePictureUrl} alt={displayName} />
            <AvatarFallback className="bg-accent text-accent-foreground text-2xl">
              {getInitials(displayName)}
            </AvatarFallback>
          </Avatar>
          <div className="space-y-2">
            <div>
              <h2 className="text-sm font-semibold">Profile photo</h2>
              <p className="text-xs text-foreground/80">
                PNG, JPEG, GIF, or WebP, up to 5 MB.
              </p>
            </div>
            <Button
              variant="secondary"
              className="border border-input font-semibold bg-foreground text-background shadow-sm hover:bg-foreground/90"
              onClick={handleAvatarClick}
              disabled={isUploading || isSaving}
              aria-label="Change profile photo"
            >
              {isUploading ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : (
                <Camera aria-hidden="true" className="size-4" />
              )}
              {isUploading ? "Uploading…" : "Change photo"}
            </Button>
            {photoError && (
              <p role="alert" className="text-xs text-destructive">
                {photoError}
              </p>
            )}
          </div>
        </div>
        <form onSubmit={handleSave} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="profile-name" className="text-accent-foreground">
              Name
            </Label>
            <Input
              id="profile-name"
              autoComplete="name"
              value={name}
              disabled={isSaving}
              onChange={(event) => {
                setNameDraft(event.target.value);
                setSaved(false);
              }}
              placeholder="Enter your name"
              className="bg-background text-accent-foreground"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-email" className="text-accent-foreground">
              Email address
            </Label>
            <div className="relative">
              <LockKeyhole
                aria-hidden="true"
                className="absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id="profile-email"
                type="email"
                autoComplete="email"
                value={user.email}
                readOnly
                aria-disabled="true"
                aria-describedby="profile-email-help"
                className="cursor-not-allowed border-dashed bg-muted pl-9 text-muted-foreground shadow-none focus-visible:ring-0"
              />
            </div>
            <p id="profile-email-help" className="text-xs text-foreground/80">
              Your sign-in email. It cannot be changed here.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-about" className="text-accent-foreground">
              About me
            </Label>
            <Textarea
              id="profile-about"
              value={info}
              disabled={isSaving}
              onChange={(event) => {
                setInfoDraft(event.target.value);
                setSaved(false);
              }}
              placeholder="Tell us a little about yourself"
              className="min-h-28 bg-background text-accent-foreground placeholder:text-foreground/60"
            />
          </div>
          {saveError && (
            <p role="alert" className="text-sm text-destructive">
              {saveError}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              variant="secondary"
              className="border border-input bg-foreground font-semibold text-background hover:bg-foreground/90"
              disabled={!dirty || isSaving || isUploading}
            >
              {isSaving ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : (
                <Save aria-hidden="true" className="size-4" />
              )}
              {isSaving ? "Saving…" : "Save changes"}
            </Button>
            {saved && (
              <p role="status" className="text-sm text-foreground">
                Changes saved.
              </p>
            )}
          </div>
        </form>
      </div>
    </SettingsPageShell>
  );
}
