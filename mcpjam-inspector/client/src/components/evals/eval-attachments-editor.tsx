import { useRef, useState } from "react";
import { Paperclip, X, Loader2 } from "lucide-react";
import { useMutation } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { Label } from "@mcpjam/design-system/label";
import { toast } from "sonner";

/**
 * COMP-17 — per-case file attachments for evals. Files are uploaded directly to
 * Convex `_storage` (content-addressed), registered on the case, and — at run
 * start — pinned by content-hash into the run snapshot and seeded into each
 * iteration's fresh sandbox at `/home/user/attachments/…` (see
 * `server/utils/computers/eval-attachments-seed.ts`).
 *
 * Clone of the skills supporting-file uploader: `generateUploadUrl` → POST blob
 * → register `{ name, storageId, contentHash }`. `size` is verified server-side
 * from `_storage`, never trusted from here.
 */

// Kept in sync with the backend caps (mcpjam-backend testSuites.ts).
const MAX_COUNT = 20;
const MAX_TOTAL_BYTES = 30 * 1024 * 1024;

export type EvalAttachment = {
  name: string;
  storageId: string;
  contentHash: string;
  size: number;
};

type EvalAttachmentsEditorProps = {
  suiteId: string;
  testCaseId: string;
  value: EvalAttachment[];
  disabled?: boolean;
};

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function EvalAttachmentsEditor({
  suiteId,
  testCaseId,
  value,
  disabled = false,
}: EvalAttachmentsEditorProps) {
  const generateUploadUrl = useMutation(
    "testSuites:generateEvalAttachmentUploadUrl" as any
  ) as unknown as (args: { suiteId: string }) => Promise<string>;
  const setTestCaseAttachments = useMutation(
    "testSuites:setTestCaseAttachments" as any
  ) as unknown as (args: {
    testCaseId: string;
    attachments: { name: string; storageId: string; contentHash: string }[];
  }) => Promise<unknown>;

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  const totalBytes = value.reduce((sum, a) => sum + a.size, 0);

  // The mutation takes the FULL desired list (register-or-remove is a replace),
  // so both add and remove funnel through here. `size` is dropped — the server
  // reads it authoritatively from `_storage`.
  const persist = async (next: EvalAttachment[]) => {
    await setTestCaseAttachments({
      testCaseId,
      attachments: next.map((a) => ({
        name: a.name,
        storageId: a.storageId,
        contentHash: a.contentHash,
      })),
    });
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const picked = Array.from(files);
    if (value.length + picked.length > MAX_COUNT) {
      toast.error(`A case can have at most ${MAX_COUNT} attachments.`);
      return;
    }
    const addedBytes = picked.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes + addedBytes > MAX_TOTAL_BYTES) {
      toast.error(
        `Attachments exceed the ${Math.round(
          MAX_TOTAL_BYTES / (1024 * 1024)
        )} MB per-case limit.`
      );
      return;
    }
    const existingNames = new Set(value.map((a) => a.name));
    setBusy(true);
    try {
      const uploaded: EvalAttachment[] = [];
      for (const file of picked) {
        if (existingNames.has(file.name)) {
          toast.error(`An attachment named "${file.name}" already exists.`);
          continue;
        }
        const buf = await file.arrayBuffer();
        const uploadUrl = await generateUploadUrl({ suiteId });
        const res = await fetch(uploadUrl, {
          method: "POST",
          headers: {
            "Content-Type": file.type || "application/octet-stream",
          },
          body: buf,
        });
        if (!res.ok) throw new Error(`upload failed (${res.status})`);
        const { storageId } = (await res.json()) as { storageId: string };
        uploaded.push({
          name: file.name,
          storageId,
          contentHash: await sha256Hex(buf),
          size: file.size,
        });
        existingNames.add(file.name);
      }
      if (uploaded.length > 0) {
        await persist([...value, ...uploaded]);
      }
    } catch (err) {
      toast.error(
        `Failed to attach file: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handleRemove = async (name: string) => {
    setBusy(true);
    try {
      await persist(value.filter((a) => a.name !== name));
    } catch (err) {
      toast.error(
        `Failed to remove attachment: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">
          Attachments
          {value.length > 0
            ? ` · ${value.length}/${MAX_COUNT} · ${formatBytes(totalBytes)}`
            : ""}
        </Label>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          disabled={disabled || busy}
          onChange={(e) => void handleFiles(e.target.files)}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Paperclip className="mr-1 h-4 w-4" />
          )}
          Add file
        </Button>
      </div>

      {value.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Files are seeded into the eval's reproducible computer at{" "}
          <code>/home/user/attachments/</code> before each iteration. Requires a
          pinned computer environment on the suite.
        </p>
      ) : (
        <ul className="space-y-1">
          {value.map((a) => (
            <li
              key={a.name}
              className="flex items-center justify-between gap-2 rounded-md border bg-card/60 px-2.5 py-1.5"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-sm text-foreground">
                  {a.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatBytes(a.size)}
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled || busy}
                onClick={() => void handleRemove(a.name)}
                aria-label={`Remove ${a.name}`}
              >
                <X className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
