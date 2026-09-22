import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";

/**
 * Ask for the endpoint a directory entry cannot supply on its own.
 *
 * Two shapes, from the row's `endpointKind`:
 *   options — several published URLs (usually regions); pick one.
 *   tenant  — no URL at all, only a pattern the customer's own instance URL
 *             must match; type it.
 *
 * `options` and `pattern` come from the CONNECT ERROR when there is one, not
 * from the card: `endpoint_url_required` carries the authoritative set, and a
 * row rendered before the last sync could be listing a region that no longer
 * exists. The card's values only seed the first attempt.
 *
 * The client-side pattern check is a courtesy, never the authority. It saves a
 * round trip on an obvious typo; the server re-checks with full-match
 * semantics and its refusal is what decides.
 */

export interface DirectoryEndpointDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the user is connecting, for the title. */
  displayName: string;
  /** `options`: choose one of these. Empty/absent means this is a tenant ask. */
  options?: string[];
  /** `tenant`: the upstream regex the typed URL must match in full. */
  pattern?: string;
  /** A refusal from the last attempt, shown inline above the actions. */
  error?: string | null;
  submitting?: boolean;
  onSubmit: (endpointUrl: string) => void;
}

/**
 * Full-match, mirroring the server's `matchesEndpointPattern`.
 *
 * Anchoring here rather than rewriting the pattern is the same decision the
 * server makes: an unanchored upstream regex (`mcp\.acme\.com`) would happily
 * match `https://evil.example/?x=mcp.acme.com`. An uncompilable pattern is
 * upstream's mistake — we let the value through and let the server answer.
 */
export function matchesEndpointPatternLocally(
  pattern: string,
  url: string
): boolean {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return true;
  }
  const match = regex.exec(url);
  return match !== null && match.index === 0 && match[0].length === url.length;
}

export function DirectoryEndpointDialog({
  open,
  onOpenChange,
  displayName,
  options,
  pattern,
  error,
  submitting = false,
  onSubmit,
}: DirectoryEndpointDialogProps) {
  const isOptions = (options?.length ?? 0) > 0;
  const [selected, setSelected] = useState<string>("");
  const [typed, setTyped] = useState<string>("");
  const [localError, setLocalError] = useState<string | null>(null);

  // Re-seed whenever the dialog opens or the authoritative choices change —
  // a retry after `endpoint_url_required` arrives with a fresher set than the
  // card had.
  useEffect(() => {
    if (!open) return;
    setSelected(options?.[0] ?? "");
    setLocalError(null);
  }, [open, options]);

  const handleSubmit = () => {
    if (isOptions) {
      if (!selected) {
        setLocalError("Choose an endpoint to continue.");
        return;
      }
      setLocalError(null);
      onSubmit(selected);
      return;
    }

    const url = typed.trim();
    if (!url) {
      setLocalError("Enter your instance URL to continue.");
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      setLocalError("A connector URL must start with http:// or https://.");
      return;
    }
    if (pattern && !matchesEndpointPatternLocally(pattern, url)) {
      setLocalError(
        "That does not look like a valid instance URL for this connector."
      );
      return;
    }
    setLocalError(null);
    onSubmit(url);
  };

  const shownError = localError ?? error ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Connect {displayName}</DialogTitle>
          <DialogDescription>
            {isOptions
              ? "This connector publishes more than one endpoint. Pick the one your account lives on."
              : "This connector runs on your own instance. Enter its URL."}
          </DialogDescription>
        </DialogHeader>

        {isOptions ? (
          <div className="space-y-2">
            <Label htmlFor="directory-endpoint-select">Endpoint</Label>
            <Select value={selected} onValueChange={setSelected}>
              <SelectTrigger
                id="directory-endpoint-select"
                data-testid="directory-endpoint-select"
                aria-label="Endpoint"
              >
                <SelectValue placeholder="Choose an endpoint" />
              </SelectTrigger>
              <SelectContent>
                {(options ?? []).map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="directory-endpoint-url">Instance URL</Label>
            <Input
              id="directory-endpoint-url"
              data-testid="directory-endpoint-url"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder="https://mcp.your-company.example/mcp"
              autoComplete="off"
              spellCheck={false}
            />
            {pattern && (
              <p className="text-xs text-muted-foreground break-all">
                Must match{" "}
                <code className="font-mono text-[11px]">{pattern}</code>
              </p>
            )}
          </div>
        )}

        {shownError && (
          <p
            role="alert"
            data-testid="directory-endpoint-error"
            className="text-xs text-destructive"
          >
            {shownError}
          </p>
        )}

        <DialogFooter className="gap-3">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Connecting…" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
