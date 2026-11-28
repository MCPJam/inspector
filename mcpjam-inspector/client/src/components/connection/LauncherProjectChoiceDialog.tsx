import { useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Label } from "@mcpjam/design-system/label";
import { RadioGroup, RadioGroupItem } from "@mcpjam/design-system/radio-group";
import {
  useLauncherProjectChoiceStore,
  type LauncherProjectChoicePrompt,
} from "@/lib/launcher-attach/project-choice";

/**
 * Asks which project a dev command's server goes to when open tabs show
 * different projects. Nothing is saved until the developer picks one.
 */
export function LauncherProjectChoiceDialog() {
  const prompt = useLauncherProjectChoiceStore((state) => state.queue[0]);
  const settle = useLauncherProjectChoiceStore((state) => state.settle);
  if (!prompt) return null;
  // Keyed per prompt so the next question starts on its own default.
  return <ProjectChoice key={prompt.attachId} prompt={prompt} settle={settle} />;
}

function ProjectChoice({
  prompt,
  settle,
}: {
  prompt: LauncherProjectChoicePrompt;
  settle: (projectId: string | null) => void;
}) {
  const [projectId, setProjectId] = useState(prompt.defaultProjectId);
  const chosen = prompt.projects.find((p) => p.id === projectId);

  return (
    <Dialog open onOpenChange={(open) => !open && settle(null)}>
      <DialogContent data-testid="launcher-project-choice-dialog">
        <DialogHeader>
          <DialogTitle>Add {prompt.serverName} to which project?</DialogTitle>
          <DialogDescription>
            Your dev command started {prompt.serverName}, and your open tabs
            show different projects. Nothing is saved until you choose.
          </DialogDescription>
        </DialogHeader>
        <RadioGroup value={projectId} onValueChange={setProjectId}>
          {prompt.projects.map((project) => (
            <div key={project.id} className="flex items-center gap-2">
              <RadioGroupItem
                value={project.id}
                id={`launcher-project-${project.id}`}
              />
              <Label htmlFor={`launcher-project-${project.id}`}>
                {project.name}
              </Label>
            </div>
          ))}
        </RadioGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => settle(null)}>
            Cancel
          </Button>
          <Button disabled={!chosen} onClick={() => settle(projectId)}>
            Add to {chosen?.name ?? "project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
