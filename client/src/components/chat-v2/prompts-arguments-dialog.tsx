import { useEffect, useMemo, useState, FormEvent } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import type { MCPPrompt } from "@/shared/types";

interface PromptsArgumentsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  promptNamespacedName: string;
  args: MCPPrompt["arguments"];
  onSubmit: (
    promptNamespacedName: string,
    values: Record<string, string>,
  ) => Promise<void>;
}

interface ArgumentField {
  name: string;
  description?: string;
  required: boolean;
  value: string;
}

export function PromptsArgumentsDialog({
  open,
  onOpenChange,
  promptNamespacedName,
  args,
  onSubmit,
}: PromptsArgumentsDialogProps) {
  const [fields, setFields] = useState<ArgumentField[]>([]);

  useEffect(() => {
    if (!open || !args || args.length === 0) {
      return;
    }
    setFields(
      args.map((arg) => ({
        name: arg.name,
        description: arg.description,
        required: Boolean(arg.required),
        value: "",
      })),
    );
  }, [args, open]);

  const handleFieldChange = (name: string, value: string) => {
    setFields((prev) =>
      prev.map((field) => (field.name === name ? { ...field, value } : field)),
    );
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values: Record<string, string> = {};
    fields.forEach((field) => {
      values[field.name] = field.value;
    });
    onSubmit(promptNamespacedName, values);
  };

  const isSubmitDisabled = useMemo(() => {
    const missingRequired = fields.some(
      (field) => field.required && !field.value.trim(),
    );
    return missingRequired;
  }, [fields]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{`Arguments for ${promptNamespacedName}`}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-6">
          {fields.map((field) => (
            <div key={field.name} className="space-y-2">
              <div className="flex items-center justify-between">
                <label
                  htmlFor={`prompt-arg-${field.name}`}
                  className="text-sm font-medium"
                >
                  {field.name}
                </label>
                {field.required && (
                  <span className="text-[11px] uppercase tracking-wide text-primary">
                    Required
                  </span>
                )}
              </div>
              <Input
                id={`prompt-arg-${field.name}`}
                value={field.value}
                placeholder={field.description || "Enter a value"}
                onChange={(event) =>
                  handleFieldChange(field.name, event.target.value)
                }
                className="h-10"
              />
              {field.description && (
                <p className="text-xs text-muted-foreground">
                  {field.description}
                </p>
              )}
            </div>
          ))}
          <div className="flex justify-end space-x-2 pt-4">
            <Button
              type="button"
              variant="outline"
              className="px-4"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitDisabled} className="px-4">
              Done
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
