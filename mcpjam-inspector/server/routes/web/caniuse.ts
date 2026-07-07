import { Hono } from "hono";
import { z } from "zod";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../utils/logger.js";
import { getClientIp } from "../../utils/client-ip.js";
import { ErrorCode, WebRouteError } from "./errors.js";

const REPORT_RATE_LIMIT = 5;
const REPORT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const BACKEND_REPORTS_PATH = "/internal/v1/caniuse/reports";
const LOCAL_REPORTS_DIR = join(process.cwd(), ".local");
const LOCAL_REPORTS_PATH = join(LOCAL_REPORTS_DIR, "caniuse-reports.jsonl");

const caniuse = new Hono();
const reportWindows = new Map<string, { count: number; windowStart: number }>();

const reportInconsistencySchema = z.object({
  message: z.string().trim().min(1).max(4000),
});

async function storeReport(args: { message: string }): Promise<{
  storage: "backend" | "local";
  reportId?: string;
  emailDeliveryStatus?: "sent" | "failed";
}> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;

  if (convexUrl && serviceToken) {
    const response = await fetch(
      `${convexUrl.replace(/\/$/, "")}${BACKEND_REPORTS_PATH}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-inspector-service-token": serviceToken,
        },
        body: JSON.stringify({ message: args.message }),
      }
    );
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      reportId?: string;
      emailDeliveryStatus?: "sent" | "failed";
      error?: string;
    } | null;
    if (!response.ok || body?.ok !== true) {
      throw new WebRouteError(
        response.status >= 400 ? response.status : 502,
        ErrorCode.SERVER_UNREACHABLE,
        body?.error ?? "Failed to store report"
      );
    }
    return {
      storage: "backend",
      reportId: body.reportId,
      emailDeliveryStatus: body.emailDeliveryStatus,
    };
  }

  if (process.env.NODE_ENV === "production") {
    throw new WebRouteError(
      503,
      ErrorCode.INTERNAL_ERROR,
      "Report storage is not configured"
    );
  }

  await mkdir(LOCAL_REPORTS_DIR, { recursive: true });
  await appendFile(
    LOCAL_REPORTS_PATH,
    `${JSON.stringify({
      message: args.message,
      source: "caniuse.dev",
      createdAt: new Date().toISOString(),
    })}\n`,
    "utf8"
  );
  logger.info("[caniuse] Inconsistency report stored locally", {
    path: LOCAL_REPORTS_PATH,
  });
  return { storage: "local" };
}

caniuse.post("/report-inconsistency", async (c) => {
  const clientKey = getClientIp(c) ?? "unknown";
  const now = Date.now();
  const rateWindow = reportWindows.get(clientKey);
  if (
    rateWindow &&
    now - rateWindow.windowStart < REPORT_RATE_LIMIT_WINDOW_MS
  ) {
    if (rateWindow.count >= REPORT_RATE_LIMIT) {
      throw new WebRouteError(
        429,
        ErrorCode.RATE_LIMITED,
        "Too many reports. Please try again later."
      );
    }
    rateWindow.count++;
  } else {
    reportWindows.set(clientKey, { count: 1, windowStart: now });
  }

  const parsed = reportInconsistencySchema.safeParse(await c.req.json());
  if (!parsed.success) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Report message is required"
    );
  }

  const stored = await storeReport({ message: parsed.data.message });
  return c.json({ success: true, stored });
});

export default caniuse;
