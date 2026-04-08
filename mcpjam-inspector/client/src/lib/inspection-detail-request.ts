/**
 * Global detail-open request helper for the inspection toast CTA.
 *
 * Extends the existing server-detail-modal-resume.ts localStorage pattern.
 * The toast writes a request, App navigates to ServersTab, and ServersTab
 * consumes the request to open the detail modal on the Overview tab.
 *
 * Includes a 5-minute TTL to prevent stale requests from reopening the
 * wrong modal after reload or navigation.
 */

const INSPECTION_DETAIL_REQUEST_KEY = "mcp-inspection-detail-request";
const INSPECTION_DETAIL_REQUEST_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface InspectionDetailRequest {
  serverName: string;
  createdAt: number;
}

function isValidRequest(value: unknown): value is InspectionDetailRequest {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as InspectionDetailRequest).serverName === "string" &&
    typeof (value as InspectionDetailRequest).createdAt === "number"
  );
}

export function writeInspectionDetailRequest(serverName: string): void {
  localStorage.setItem(
    INSPECTION_DETAIL_REQUEST_KEY,
    JSON.stringify({
      serverName,
      createdAt: Date.now(),
    } satisfies InspectionDetailRequest),
  );
}

/**
 * Read and return a pending detail request.
 * Returns null if missing, invalid, or stale (> 5 min TTL).
 * Stale entries are auto-cleared.
 */
export function readInspectionDetailRequest(): InspectionDetailRequest | null {
  try {
    const raw = localStorage.getItem(INSPECTION_DETAIL_REQUEST_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!isValidRequest(parsed)) {
      localStorage.removeItem(INSPECTION_DETAIL_REQUEST_KEY);
      return null;
    }

    if (Date.now() - parsed.createdAt > INSPECTION_DETAIL_REQUEST_TTL_MS) {
      localStorage.removeItem(INSPECTION_DETAIL_REQUEST_KEY);
      return null;
    }

    return parsed;
  } catch {
    localStorage.removeItem(INSPECTION_DETAIL_REQUEST_KEY);
    return null;
  }
}

export function clearInspectionDetailRequest(): void {
  localStorage.removeItem(INSPECTION_DETAIL_REQUEST_KEY);
}
