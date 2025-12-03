import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useRegistrySourcesStore } from "@/stores/registry/registry-sources-store";
import { listRegistryServers, isAuthRequired } from "@/lib/registry-api";
import { Loader2, AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";

interface AddRegistryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRegistryAdded?: (registryUrl: string) => void;
}

export function AddRegistryDialog({
  open,
  onOpenChange,
  onRegistryAdded,
}: AddRegistryDialogProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [isChecking, setIsChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { addSource, setActiveSource, sources } = useRegistrySourcesStore();

  const resetForm = () => {
    setName("");
    setUrl("");
    setError(null);
    setIsChecking(false);
  };

  const handleClose = () => {
    resetForm();
    onOpenChange(false);
  };

  const handleAdd = async () => {
    setIsChecking(true);
    setError(null);

    try {
      // Validate URL format
      let registryUrl: URL;
      try {
        registryUrl = new URL(url);
      } catch {
        throw new Error("Invalid URL format");
      }

      // Check if registry already exists
      const existingSource = sources.find((s) => s.url === registryUrl.toString());
      if (existingSource) {
        throw new Error("This registry is already added");
      }

      // Try to fetch from the registry (will tell us if auth is needed)
      const result = await listRegistryServers({
        registryUrl: registryUrl.toString(),
        limit: 1,
      });

      const requiresAuth = isAuthRequired(result);

      // Add the new source
      const sourceId = addSource({
        name: name.trim() || registryUrl.hostname,
        url: registryUrl.toString(),
        isOfficial: false,
        requiresAuth,
      });

      // Set as active source
      setActiveSource(sourceId);

      // Notify parent
      if (onRegistryAdded) {
        onRegistryAdded(registryUrl.toString());
      }

      if (requiresAuth) {
        toast.info("Registry added", {
          description:
            "This registry requires authentication. OAuth support coming soon!",
        });
      } else {
        toast.success("Registry added", {
          description: `Successfully connected to ${name || registryUrl.hostname}`,
        });
      }

      handleClose();
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Failed to connect to registry";
      setError(message);
    } finally {
      setIsChecking(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && url && !isChecking) {
      handleAdd();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Add Registry</DialogTitle>
          <DialogDescription>
            Connect to a custom MCP server registry. Enter the base URL of the
            registry API.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="registry-name">Name (optional)</Label>
            <Input
              id="registry-name"
              placeholder="My Company Registry"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <p className="text-xs text-muted-foreground">
              A friendly name to identify this registry
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="registry-url">Registry URL</Label>
            <Input
              id="registry-url"
              placeholder="https://registry.example.com/v0.1"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <p className="text-xs text-muted-foreground">
              The base URL of the registry API (e.g.,
              https://registry.example.com/v0.1)
            </p>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button onClick={handleAdd} disabled={!url.trim() || isChecking}>
            {isChecking && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {isChecking ? "Checking..." : "Add Registry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
