import { Download, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type AuditEvent, useOrganizationAudit } from "@/hooks/useOrganizationAudit";

interface OrganizationAuditLogProps {
  organizationId: string;
  organizationName: string;
  isAuthenticated: boolean;
}

function safeStringify(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable metadata]";
  }
}

function toCsvCell(value: unknown): string {
  const raw = value === undefined || value === null ? "" : String(value);
  if (raw.includes(",") || raw.includes('"') || raw.includes("\n")) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function toDownloadSlug(value: string): string {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "organization";
}

function classifyAuditError(
  error: Error | null,
): "none" | "missing" | "permission" | "other" {
  if (!error) return "none";
  const message = error.message.toLowerCase();
  if (
    message.includes("auditevents:listbyorganization") &&
    (message.includes("could not find") ||
      message.includes("not found") ||
      message.includes("not registered"))
  ) {
    return "missing";
  }
  if (
    message.includes("permission") ||
    message.includes("forbidden") ||
    message.includes("requires admin") ||
    message.includes("insufficient")
  ) {
    return "permission";
  }
  return "other";
}

function buildCsvRows(events: AuditEvent[]) {
  const headers = [
    "timestamp_iso",
    "actor_type",
    "actor_email",
    "action",
    "target_type",
    "target_id",
    "organization_id",
    "workspace_id",
    "metadata_json",
  ];

  const rows = events.map((event) => [
    new Date(event.timestamp).toISOString(),
    event.actorType,
    event.actorEmail ?? "",
    event.action,
    event.targetType,
    event.targetId,
    event.organizationId ?? "",
    event.workspaceId ?? "",
    safeStringify(event.metadata),
  ]);

  return [headers, ...rows].map((row) => row.map(toCsvCell).join(",")).join("\n");
}

export function OrganizationAuditLog({
  organizationId,
  organizationName,
  isAuthenticated,
}: OrganizationAuditLogProps) {
  const { events, isLoading, isLoadingMore, error, refresh } = useOrganizationAudit({
    organizationId,
    isAuthenticated,
    initialLimit: 500,
  });

  const handleExportCsv = () => {
    if (events.length === 0) return;

    const csv = buildCsvRows(events);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const datePart = new Date().toISOString().slice(0, 10);
    link.href = objectUrl;
    link.download = `organization-audit-${toDownloadSlug(organizationName)}-${datePart}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(objectUrl);
  };

  const isBusy = isLoading || isLoadingMore;
  const errorType = classifyAuditError(error);
  const errorMessage =
    errorType === "missing"
      ? "Audit export is unavailable because the backend audit function is not deployed yet."
      : errorType === "permission"
        ? "You don't have permission to access organization audit events."
        : error?.message ?? null;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Audit Log</h3>
          <p className="text-sm text-muted-foreground">
            Export organization activity as CSV.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void refresh()} disabled={isBusy}>
            <RefreshCw className={`mr-2 size-4 ${isBusy ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button variant="outline" onClick={handleExportCsv} disabled={events.length === 0 || isBusy}>
            <Download className="mr-2 size-4" />
            Export CSV
          </Button>
        </div>
      </div>

      {errorMessage && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {errorMessage}
        </div>
      )}

      {!errorMessage && isBusy && events.length === 0 && (
        <div className="flex items-center gap-2 rounded-md border p-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading audit events...
        </div>
      )}
    </section>
  );
}
