import { useEffect, useId, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@mcpjam/design-system/dialog";
import { updateSkill, type SkillsSource } from "@/lib/apis/mcp-skills-api";
import type { Skill } from "@/shared/skill-types";

interface SkillEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The skill being edited (cloud-only in v1). */
  skill: Skill | null;
  /** Stable cloud id — the update is keyed by id, not name. */
  skillId: string | undefined;
  source?: SkillsSource;
  /** Called after a successful save so the parent can refresh + reselect. */
  onSaved?: (updated: Skill) => void;
}

/**
 * Edit a cloud skill's description + body (name stays fixed in v1 to keep the
 * on-box dir / loadSkill identity stable). Fully controlled: the form seeds from
 * `skill` whenever the dialog opens. The server enforces manage permission and
 * 403s if the caller may not edit this skill — surfaced as an inline error.
 */
export function SkillEditDialog({
  open,
  onOpenChange,
  skill,
  skillId,
  source,
  onSaved,
}: SkillEditDialogProps) {
  // Hooks BEFORE any early return (rules-of-hooks).
  const descriptionId = useId();
  const contentId = useId();
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the form each time the dialog opens on a (possibly new) skill.
  useEffect(() => {
    if (open && skill) {
      setDescription(skill.description);
      setContent(skill.content);
      setError(null);
    }
  }, [open, skill]);

  const canSave =
    !!skillId &&
    description.trim().length > 0 &&
    content.trim().length > 0 &&
    !isSaving;

  const handleSave = async () => {
    if (!skillId) return;
    setError(null);
    setIsSaving(true);
    try {
      const updated = await updateSkill(
        skillId,
        { description: description.trim(), content: content.trim() },
        source,
      );
      onSaved?.(updated);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit skill{skill ? `: ${skill.name}` : ""}</DialogTitle>
          <DialogDescription>
            Update this skill&apos;s description and instructions. Changes apply
            everywhere the skill is used (chat and your Computer).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor={descriptionId} className="text-sm font-medium">
              Description
            </label>
            <textarea
              id={descriptionId}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isSaving}
              rows={2}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-y"
              placeholder="What this skill is for (shown in the picker)."
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={contentId} className="text-sm font-medium">
              Instructions (SKILL.md)
            </label>
            <textarea
              id={contentId}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              disabled={isSaving}
              rows={14}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono resize-y"
              placeholder="The skill's full instructions (markdown body)."
            />
          </div>

          {error && (
            <div className="p-3 text-sm text-destructive bg-destructive/10 rounded-md">
              {error}
            </div>
          )}

          <div className="flex justify-end space-x-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button type="button" onClick={handleSave} disabled={!canSave}>
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="h-4 w-4 mr-2" />
                  Save
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
