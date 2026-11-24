import { useRef, useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  recordSubmissionEvent,
  type SubmissionSummary,
  type SubmissionEventBody,
} from "@/lib/apis/directory-submissions-api";
import type { PlatformServerRevisionSummary } from "@mcpjam/sdk/platform";

export function RecordRelease({
  projectId,
  serverId,
  submission,
  revisions,
  onSaved,
  onCancel,
}: {
  projectId: string;
  serverId: string;
  submission: SubmissionSummary;
  revisions: PlatformServerRevisionSummary[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const retry = useRef({ body: "", key: "" });
  return (
    <form
      className="grid max-w-md gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (saving) return;
        const form = new FormData(e.currentTarget);
        const note = String(form.get("version")).trim();
        const link = String(form.get("link")).trim();
        const detail = String(form.get("metadata")).trim();
        const revisionNumber = Number(form.get("revision")) || undefined;
        const publishedOn = String(form.get("publishedOn") || "");
        const evidenceText = [
          publishedOn && `Published on ${publishedOn}`,
          form.has("package") &&
            submission.pluginVersionId &&
            `Plugin version ID · ${submission.pluginVersionId}`,
        ]
          .filter(Boolean)
          .join("\n");
        const body: SubmissionEventBody = {
          kind: "snapshot",
          reportedOrObserved: "observed",
          evidence: evidenceText
            ? { kind: "text", value: evidenceText }
            : undefined,
          snapshot: {
            label: "published",
            serverId,
            revisionNumber,
            note: `Version ${note}`,
          },
          link: link || undefined,
          detail: detail || undefined,
        };
        const fingerprint = JSON.stringify(body);
        if (retry.current.body !== fingerprint)
          retry.current = { body: fingerprint, key: crypto.randomUUID() };
        setSaving(true);
        try {
          await recordSubmissionEvent(
            { projectId, submissionId: submission.id },
            { ...body, idempotencyKey: retry.current.key },
          );
          onSaved();
        } catch (failure) {
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not record the release. Try saving again.",
          );
        } finally {
          setSaving(false);
        }
      }}
    >
      {error && <p role="alert">{error}</p>}
      <label>
        Published version
        <Input name="version" required maxLength={200} pattern=".*\S.*" />
      </label>
      <label>
        Publication date
        <Input type="date" name="publishedOn" />
      </label>
      {submission.pluginVersionId && (
        <label>
          <input type="checkbox" name="package" /> This release uses the
          selected plugin version ({submission.pluginVersionId})
        </label>
      )}
      <label>
        Marketplace listing URL
        <Input name="link" type="url" pattern="https://.+" />
      </label>
      <label>
        Published listing metadata
        <Input
          name="metadata"
          maxLength={3500}
          placeholder="Listing name and description"
        />
      </label>
      <label>
        Published MCP catalog{" "}
        <select name="revision" defaultValue="">
          <option value="">Revision unknown</option>
          {revisions.map((r) => (
            <option key={r.revisionNumber} value={r.revisionNumber}>
              Revision {r.revisionNumber} ·{" "}
              {new Date(r.capturedAt).toLocaleDateString()} · {r.counts.tools}{" "}
              tools
            </option>
          ))}
        </select>
      </label>
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          Save release
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
