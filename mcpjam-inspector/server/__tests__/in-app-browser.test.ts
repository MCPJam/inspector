import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  detectInAppBrowser,
  generateRedirectPage,
  inAppBrowserMiddleware,
} from "../middleware/in-app-browser.js";

// ─── detectInAppBrowser() ───────────────────────────────────────────────────

describe("detectInAppBrowser", () => {
  it("detects LinkedIn in-app browser", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 LinkedInApp";
    expect(detectInAppBrowser(ua)).toBe("LinkedIn");
  });

  it("detects Facebook in-app browser (FBAN)", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21A329 [FBAN/FBIOS;FBAV/430.0.0]";
    expect(detectInAppBrowser(ua)).toBe("Facebook");
  });

  it("detects Facebook in-app browser (FBAV only)", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36 FBAV/441.0";
    expect(detectInAppBrowser(ua)).toBe("Facebook");
  });

  it("detects Instagram in-app browser", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21A329 Instagram 300.0";
    expect(detectInAppBrowser(ua)).toBe("Instagram");
  });

  it("detects TikTok in-app browser (BytedanceWebview)", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36 BytedanceWebview";
    expect(detectInAppBrowser(ua)).toBe("TikTok");
  });

  it("detects TikTok in-app browser (musical_ly)", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/21A329 musical_ly";
    expect(detectInAppBrowser(ua)).toBe("TikTok");
  });

  it("detects Twitter in-app browser", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/21A329 Twitter";
    expect(detectInAppBrowser(ua)).toBe("Twitter");
  });

  it("detects Snapchat in-app browser", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/21A329 Snapchat/12.0";
    expect(detectInAppBrowser(ua)).toBe("Snapchat");
  });

  it("detects Pinterest in-app browser", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/21A329 Pinterest/11.0";
    expect(detectInAppBrowser(ua)).toBe("Pinterest");
  });

  it("detects generic Android WebView", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 12; Pixel 6 Build/SD1A.210817.036; wv) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36";
    expect(detectInAppBrowser(ua)).toBe("this app");
  });

  it("returns null for standard Chrome on Android", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
    expect(detectInAppBrowser(ua)).toBeNull();
  });

  it("returns null for standard Safari on iOS", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    expect(detectInAppBrowser(ua)).toBeNull();
  });

  it("returns null for desktop Chrome", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    expect(detectInAppBrowser(ua)).toBeNull();
  });

  it("returns null for desktop Firefox", () => {
    const ua =
      "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0";
    expect(detectInAppBrowser(ua)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(detectInAppBrowser("")).toBeNull();
  });

  it("returns null for undefined-like input", () => {
    expect(detectInAppBrowser("")).toBeNull();
  });
});

// ─── generateRedirectPage() ─────────────────────────────────────────────────

describe("generateRedirectPage", () => {
  it("returns valid HTML with MCPJam branding", () => {
    const html = generateRedirectPage("https://app.mcpjam.com/foo", "LinkedIn");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("MCPJam");
  });

  it("includes the original URL for copy functionality", () => {
    const url = "https://app.mcpjam.com/some/path?query=1";
    const html = generateRedirectPage(url, "Facebook");
    expect(html).toContain(url);
  });

  it("includes Android intent redirect script", () => {
    const html = generateRedirectPage("https://app.mcpjam.com", "LinkedIn");
    expect(html).toContain("intent://");
    expect(html).toContain("android.intent.action.VIEW");
  });

  it("includes copy link button", () => {
    const html = generateRedirectPage("https://app.mcpjam.com", "LinkedIn");
    expect(html).toContain("Copy link");
    expect(html).toContain("copyBtn");
  });

  it("includes browser instructions", () => {
    const html = generateRedirectPage("https://app.mcpjam.com", "LinkedIn");
    expect(html).toContain("Open in Safari");
    expect(html).toContain("Open in Browser");
  });

  it("uses design system oklch colors", () => {
    const html = generateRedirectPage("https://app.mcpjam.com", "LinkedIn");
    // Light theme primary and background
    expect(html).toContain("oklch(0.6832 0.1382 38.744)");
    expect(html).toContain("oklch(0.9818 0.0054 95.0986)");
  });

  it("does not render app name in page content", () => {
    const html = generateRedirectPage(
      "https://app.mcpjam.com",
      '<script>alert("xss")</script>',
    );
    // App name is not rendered in the HTML, so XSS via appName is not possible
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).not.toContain("&lt;script&gt;");
  });
});

// ─── inAppBrowserMiddleware ─────────────────────────────────────────────────

// Uses the real inAppBrowserMiddleware export (ENABLE_IN_APP_DETECTION is true
// in test env since NODE_ENV !== "production").
describe("inAppBrowserMiddleware", () => {
  const LINKEDIN_UA =
    "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36 LinkedInApp";
  const CHROME_UA =
    "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36";

  function createTestApp() {
    const app = new Hono();

    // API route (registered before middleware, like in real app)
    app.get("/api/test", (c) => c.json({ ok: true }));
    // Asset route
    app.get("/assets/main.js", (c) => c.text("console.log('app')"));
    // POST route
    app.post("/submit", (c) => c.json({ submitted: true }));

    // Real middleware
    app.use("/*", inAppBrowserMiddleware);

    // SPA fallback
    app.get("/*", (c) => c.html("<html><body>SPA</body></html>"));

    return app;
  }

  it("returns redirect page for in-app browser UA", async () => {
    const app = createTestApp();
    const res = await app.request("/", {
      headers: { "User-Agent": LINKEDIN_UA },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("MCPJam");
    expect(body).toContain("Copy link");
  });

  it("sets cache-busting headers on redirect page", async () => {
    const app = createTestApp();
    const res = await app.request("/", {
      headers: { "User-Agent": LINKEDIN_UA },
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Vary")).toContain("User-Agent");
  });

  it("passes through for normal browser UA", async () => {
    const app = createTestApp();
    const res = await app.request("/", {
      headers: { "User-Agent": CHROME_UA },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("SPA");
  });

  it("skips API routes even with in-app browser UA", async () => {
    const app = createTestApp();
    const res = await app.request("/api/test", {
      headers: { "User-Agent": LINKEDIN_UA },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"ok":true');
  });

  it("skips /assets/ paths even with in-app browser UA", async () => {
    const app = createTestApp();
    const res = await app.request("/assets/main.js", {
      headers: { "User-Agent": LINKEDIN_UA },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("console.log");
  });

  it("skips non-GET requests even with in-app browser UA", async () => {
    const app = createTestApp();
    const res = await app.request("/submit", {
      method: "POST",
      headers: { "User-Agent": LINKEDIN_UA },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("submitted");
  });

  it("works with deep paths", async () => {
    const app = createTestApp();
    const res = await app.request("/shared/chat/abc123", {
      headers: { "User-Agent": LINKEDIN_UA },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("MCPJam");
  });

  it("works with Facebook UA", async () => {
    const app = createTestApp();
    const fbUA =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/21A329 [FBAN/FBIOS;FBAV/430.0]";
    const res = await app.request("/", {
      headers: { "User-Agent": fbUA },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("MCPJam");
    expect(body).toContain("Copy link");
  });
});
