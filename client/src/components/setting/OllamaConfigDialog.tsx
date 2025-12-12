import { ExternalLink } from "lucide-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

interface OllamaConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onValueChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

export function OllamaConfigDialog({
  open,
  onOpenChange,
  value,
  onValueChange,
  onSave,
  onCancel,
}: OllamaConfigDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-lg bg-card p-2 border">
              <img
                src="/ollama_logo.svg"
                alt="Ollama"
                className="w-full h-full object-contain"
              />
            </div>
            <div>
              <DialogTitle className="text-left pb-2">
                Configure Ollama URL
              </DialogTitle>
              <DialogDescription className="text-left">
                Set the base URL for your Ollama instance
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label htmlFor="ollama-url" className="text-sm font-medium">
              Base URL
            </label>
            <Input
              id="ollama-url"
              type="url"
              value={value}
              onChange={(e) => onValueChange(e.target.value)}
              placeholder="http://127.0.0.1:11434/api"
              className="mt-1"
            />
          </div>

          <div className="flex items-center gap-2 p-3 bg-info/10 rounded-lg">
            <ExternalLink className="w-4 h-4 text-info" />
            <span className="text-sm text-info">
              Need help?{" "}
              <button
                onClick={() =>
                  window.open("https://ollama.ai/download", "_blank")
                }
                className="underline hover:no-underline"
              >
                Download Ollama
              </button>
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={!value.trim()}>
            Save URL
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
