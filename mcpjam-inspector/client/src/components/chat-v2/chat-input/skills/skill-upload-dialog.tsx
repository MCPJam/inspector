import { useState, FormEvent, useMemo } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { uploadSkill } from "@/lib/apis/mcp-skills-api";
import type { SkillResult } from "./skill-types";

interface SkillUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSkillCreated?: (skill: SkillResult) => void;
}

/**
 * Validates skill name format: lowercase letters, numbers, hyphens only
 */
function isValidSkillName(name: string): boolean {
  return /^[a-z0-9-]+$/.test(name);
}

export function SkillUploadDialog({
  open,
  onOpenChange,
  onSkillCreated,
}: SkillUploadDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setName("");
    setDescription("");
    setContent("");
    setError(null);
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      resetForm();
    }
    onOpenChange(newOpen);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();

    // Validate name format
    if (!isValidSkillName(name)) {
      setError("Name must contain only lowercase letters, numbers, and hyphens");
      return;
    }

    setError(null);
    setIsLoading(true);

    try {
      const skill = await uploadSkill({ name, description, content });
      onSkillCreated?.(skill);
      handleOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  const isSubmitDisabled = useMemo(() => {
    return (
      !name.trim() ||
      !description.trim() ||
      !content.trim() ||
      isLoading
    );
  }, [name, description, content, isLoading]);

  const nameError = useMemo(() => {
    if (!name) return null;
    if (!isValidSkillName(name)) {
      return "Use only lowercase letters, numbers, and hyphens";
    }
    return null;
  }, [name]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create New Skill</DialogTitle>
          <DialogDescription>
            Skills are markdown files that provide contextual instructions for AI
            models. They will be saved to{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">
              ~/.mcpjam/skills/{name || "{name}"}/SKILL.md
            </code>
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Name field */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="skill-name" className="text-sm font-medium">
                Name
              </label>
              <span className="text-[11px] uppercase tracking-wide text-primary">
                Required
              </span>
            </div>
            <Input
              id="skill-name"
              value={name}
              placeholder="my-skill"
              onChange={(e) => setName(e.target.value.toLowerCase())}
              className={nameError ? "border-destructive" : ""}
            />
            {nameError && (
              <p className="text-xs text-destructive">{nameError}</p>
            )}
            <p className="text-xs text-muted-foreground">
              A unique identifier using lowercase letters, numbers, and hyphens.
            </p>
          </div>

          {/* Description field */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="skill-description" className="text-sm font-medium">
                Description
              </label>
              <span className="text-[11px] uppercase tracking-wide text-primary">
                Required
              </span>
            </div>
            <Input
              id="skill-description"
              value={description}
              placeholder="A brief description of what this skill does"
              onChange={(e) => setDescription(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Shown in the skills menu to help users understand its purpose.
            </p>
          </div>

          {/* Content field */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="skill-content" className="text-sm font-medium">
                Content
              </label>
              <span className="text-[11px] uppercase tracking-wide text-primary">
                Required
              </span>
            </div>
            <Textarea
              id="skill-content"
              value={content}
              placeholder="# My Skill&#10;&#10;Instructions for the AI model..."
              onChange={(e) => setContent(e.target.value)}
              className="min-h-[200px] font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Markdown content that will be sent to the AI model when this skill
              is activated.
            </p>
          </div>

          {/* Error message */}
          {error && (
            <div className="p-3 text-sm text-destructive bg-destructive/10 rounded-md">
              {error}
            </div>
          )}

          {/* Action buttons */}
          <div className="flex justify-end space-x-2 pt-4">
            <Button
              type="button"
              variant="outline"
              className="px-4"
              onClick={() => handleOpenChange(false)}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitDisabled} className="px-4">
              {isLoading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Creating...
                </>
              ) : (
                "Create Skill"
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
