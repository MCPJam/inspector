import { Hono } from "hono";
import { z } from "zod";
import { getClientIp } from "../../utils/client-ip.js";
import { ErrorCode, WebRouteError, readJsonBody } from "./errors.js";

const REPORT_RATE_LIMIT = 10;
const REPORT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const BACKEND_REPORTS_PATH = "/internal/v1/caniuse/reports";
const BACKEND_SUBSCRIBERS_PATH = "/internal/v1/caniuse/subscribers";

const caniuse = new Hono();
const reportWindows = new Map<string, { count: number; windowStart: number }>();
const subscribeWindows = new Map<
  string,
  { count: number; windowStart: number }
>();

function consumeRateLimit(
  windows: Map<string, { count: number; windowStart: number }>,
  clientKey: string,
  now: number,
  message: string
) {
  for (const [key, value] of windows) {
    if (now - value.windowStart >= REPORT_RATE_LIMIT_WINDOW_MS) {
      windows.delete(key);
    }
  }

  const rateWindow = windows.get(clientKey);
  if (rateWindow) {
    if (rateWindow.count >= REPORT_RATE_LIMIT) {
      throw new WebRouteError(429, ErrorCode.RATE_LIMITED, message);
    }
    rateWindow.count++;
    return;
  }

  windows.set(clientKey, { count: 1, windowStart: now });
}

const reportInconsistencySchema = z.object({
  message: z.string().trim().min(1).max(4000),
});

const subscribeSchema = z.object({
  email: z.string().trim().email().max(320),
});

async function storeReport(args: { message: string }): Promise<{
  storage: "backend";
  reportId?: string;
  emailDeliveryStatus?: "sent" | "failed";
}> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;

  if (!convexUrl || !serviceToken) {
    throw new WebRouteError(
      503,
      ErrorCode.INTERNAL_ERROR,
      "Report storage is not configured"
    );
  }

  let response: Response;
  try {
    response = await fetch(
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
  } catch {
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      "Failed to store report"
    );
  }

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

caniuse.post("/report-inconsistency", async (c) => {
  const clientKey = getClientIp(c) ?? "unknown";
  consumeRateLimit(
    reportWindows,
    clientKey,
    Date.now(),
    "Too many reports. Please try again later."
  );

  const parsed = reportInconsistencySchema.safeParse(
    await readJsonBody<unknown>(c)
  );
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

async function storeSubscriber(args: { email: string }): Promise<{
  storage: "backend";
  created?: boolean;
}> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;

  if (!convexUrl || !serviceToken) {
    throw new WebRouteError(
      503,
      ErrorCode.INTERNAL_ERROR,
      "Subscription storage is not configured"
    );
  }

  let response: Response;
  try {
    response = await fetch(
      `${convexUrl.replace(/\/$/, "")}${BACKEND_SUBSCRIBERS_PATH}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-inspector-service-token": serviceToken,
        },
        body: JSON.stringify({ email: args.email }),
      }
    );
  } catch {
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      "Failed to save subscription"
    );
  }

  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    created?: boolean;
    error?: string;
  } | null;
  if (!response.ok || body?.ok !== true) {
    throw new WebRouteError(
      response.status >= 400 ? response.status : 502,
      ErrorCode.SERVER_UNREACHABLE,
      body?.error ?? "Failed to save subscription"
    );
  }
  return { storage: "backend", created: body.created };
}

caniuse.post("/subscribe", async (c) => {
  const clientKey = getClientIp(c) ?? "unknown";
  consumeRateLimit(
    subscribeWindows,
    clientKey,
    Date.now(),
    "Too many attempts. Please try again later."
  );

  const parsed = subscribeSchema.safeParse(await readJsonBody<unknown>(c));
  if (!parsed.success) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "A valid email is required"
    );
  }

  const stored = await storeSubscriber({ email: parsed.data.email });
  return c.json({ success: true, stored });
});

export default caniuse;
