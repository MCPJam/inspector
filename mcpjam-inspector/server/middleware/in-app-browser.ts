/**
 * In-App Browser Detection & Redirect Middleware
 *
 * When users open MCPJam links inside apps like LinkedIn, Facebook, Instagram,
 * etc., those apps use embedded WebView browsers. Google blocks OAuth sign-in
 * from these WebViews with `403 disallowed_useragent`.
 *
 * This middleware detects in-app browsers and serves a redirect page that
 * helps users open the link in their default system browser instead.
 */

import type { Context, Next } from "hono";
import { HOSTED_MODE } from "../config.js";

const ENABLE_IN_APP_DETECTION =
  HOSTED_MODE || process.env.NODE_ENV !== "production";

/**
 * Known in-app browser User-Agent patterns.
 * Each entry maps a regex pattern to a human-readable app name.
 */
const IN_APP_BROWSER_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /LinkedInApp/i, name: "LinkedIn" },
  { pattern: /FBAN|FBAV/i, name: "Facebook" },
  { pattern: /Instagram/i, name: "Instagram" },
  { pattern: /BytedanceWebview|musical_ly/i, name: "TikTok" },
  { pattern: /Twitter|TwitterAndroid/i, name: "Twitter" },
  { pattern: /Snapchat/i, name: "Snapchat" },
  { pattern: /Pinterest/i, name: "Pinterest" },
  // Generic Android WebView marker (must come last as it's less specific)
  { pattern: /; wv\)/i, name: "this app" },
];

/**
 * Detects if a User-Agent string belongs to an in-app browser.
 * @returns The app name if detected, or null for normal browsers.
 */
export function detectInAppBrowser(userAgent: string): string | null {
  if (!userAgent) return null;

  for (const { pattern, name } of IN_APP_BROWSER_PATTERNS) {
    if (pattern.test(userAgent)) {
      return name;
    }
  }

  return null;
}

/**
 * Generates a self-contained HTML redirect page that helps users
 * open the current URL in their default system browser.
 */
export function generateRedirectPage(
  originalUrl: string,
  appName: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Open in Browser - MCPJam</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: oklch(0.9818 0.0054 95.0986);
      color: oklch(0.3438 0.0269 95.7226);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      max-width: 400px;
      width: 100%;
      text-align: center;
      background: oklch(1 0 0);
      border: 1px solid oklch(0.8847 0.0069 97.3627);
      border-radius: 1rem;
      padding: 48px 40px;
    }
    .logo { margin-bottom: 24px; }
    .logo svg { width: 64px; height: 64px; }
    h1 {
      font-size: 18px;
      font-weight: 500;
      color: oklch(0.3438 0.0269 95.7226);
      margin-bottom: 28px;
    }
    .copy-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 10px 32px;
      background: oklch(0.6832 0.1382 38.744);
      color: oklch(1 0 0);
      border: none;
      border-radius: 0.5rem;
      font-size: 15px;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .copy-btn:active { opacity: 0.85; }
    .copy-btn.copied { background: oklch(0.696 0.17 152.5); }
    .hint {
      margin-top: 24px;
      color: oklch(0.6059 0.0075 97.4233);
      font-size: 13px;
      line-height: 1.5;
    }
    .hint strong { color: oklch(0.3438 0.0269 95.7226); }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <svg viewBox="0 0 1080 1080" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="1080" height="1080" rx="241" ry="241" fill="#2D2D2D"/><path d="M196.547 508V298H245.447L332.447 440.8H306.647L391.247 298H440.147L440.747 508H386.147L385.547 381.1H394.847L331.547 487.3H305.147L240.047 381.1H251.447V508H196.547ZM587.477 512.2C570.877 512.2 555.477 509.6 541.277 504.4C527.277 499 515.077 491.4 504.677 481.6C494.477 471.8 486.477 460.3 480.677 447.1C474.877 433.7 471.977 419 471.977 403C471.977 387 474.877 372.4 480.677 359.2C486.477 345.8 494.477 334.2 504.677 324.4C515.077 314.6 527.277 307.1 541.277 301.9C555.477 296.5 570.877 293.8 587.477 293.8C606.877 293.8 624.177 297.2 639.377 304C654.777 310.8 667.577 320.6 677.777 333.4L639.977 367.6C633.177 359.6 625.677 353.5 617.477 349.3C609.477 345.1 600.477 343 590.477 343C581.877 343 573.977 344.4 566.777 347.2C559.577 350 553.377 354.1 548.177 359.5C543.177 364.7 539.177 371 536.177 378.4C533.377 385.8 531.977 394 531.977 403C531.977 412 533.377 420.2 536.177 427.6C539.177 435 543.177 441.4 548.177 446.8C553.377 452 559.577 456 566.777 458.8C573.977 461.6 581.877 463 590.477 463C600.477 463 609.477 460.9 617.477 456.7C625.677 452.5 633.177 446.4 639.977 438.4L677.777 472.6C667.577 485.2 654.777 495 639.377 502C624.177 508.8 606.877 512.2 587.477 512.2ZM704.262 508V298H800.262C819.462 298 835.962 301.1 849.762 307.3C863.762 313.5 874.562 322.5 882.162 334.3C889.762 345.9 893.562 359.7 893.562 375.7C893.562 391.5 889.762 405.2 882.162 416.8C874.562 428.4 863.762 437.4 849.762 443.8C835.962 450 819.462 453.1 800.262 453.1H737.262L763.662 427.3V508H704.262ZM763.662 433.6L737.262 406.3H796.662C809.062 406.3 818.262 403.6 824.262 398.2C830.462 392.8 833.562 385.3 833.562 375.7C833.562 365.9 830.462 358.3 824.262 352.9C818.262 347.5 809.062 344.8 796.662 344.8H737.262L763.662 317.5V433.6Z" fill="#FBFBFB"/><path d="M264.566 792.2C249.166 792.2 235.166 789.6 222.566 784.4C210.166 779 199.866 771.3 191.666 761.3L224.066 722.9C229.666 730.1 235.466 735.6 241.466 739.4C247.466 743 253.766 744.8 260.366 744.8C277.966 744.8 286.766 734.6 286.766 714.2V623.9H214.166V578H345.566V710.6C345.566 738 338.666 758.5 324.866 772.1C311.066 785.5 290.966 792.2 264.566 792.2ZM356.064 788L448.764 578H507.264L600.264 788H538.464L465.864 607.1H489.264L416.664 788H356.064ZM406.764 747.2L422.064 703.4H524.664L539.964 747.2H406.764ZM617.104 788V578H666.004L753.004 720.8H727.204L811.804 578H860.704L861.304 788H806.704L806.104 661.1H815.404L752.104 767.3H725.704L660.604 661.1H672.004V788H617.104Z" fill="#F2735B"/></svg>
    </div>
    <h1>Open in your browser to continue</h1>
    <button class="copy-btn" id="copyBtn" type="button">Copy link</button>
    <p class="hint">
      Or tap <strong>&#x22EF;</strong> then <strong>"Open in Safari"</strong> / <strong>"Open in Browser"</strong>
    </p>
  </div>
  <script>
    (function() {
      var url = ${JSON.stringify(originalUrl)};

      // Android: attempt to open in default browser via intent URL
      var ua = navigator.userAgent || "";
      if (/android/i.test(ua)) {
        try {
          var parsed = new URL(url);
          // Build intent URL without the original hash (which would conflict with #Intent)
          var intent = "intent://" + parsed.host + parsed.pathname + parsed.search
            + "#Intent;scheme=" + parsed.protocol.replace(":", "")
            + ";action=android.intent.action.VIEW"
            + ";S.browser_fallback_url=" + encodeURIComponent(url)
            + ";end";
          window.location.href = intent;
        } catch(e) {}
      }

      // Copy link button
      var btn = document.getElementById("copyBtn");
      btn.addEventListener("click", function() {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(onCopied).catch(fallbackCopy);
        } else {
          fallbackCopy();
        }
      });

      function fallbackCopy() {
        var ta = document.createElement("textarea");
        ta.value = url;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); onCopied(); } catch(e) {}
        document.body.removeChild(ta);
      }

      function onCopied() {
        btn.textContent = "✓ Link copied!";
        btn.classList.add("copied");
        setTimeout(function() {
          btn.textContent = "Copy link";
          btn.classList.remove("copied");
        }, 2000);
      }
    })();
  </script>
</body>
</html>`;
}

/**
 * Hono middleware that detects in-app browsers and serves a redirect page.
 * Only active in HOSTED_MODE. Skips API routes, static assets, and non-GET requests.
 */
export async function inAppBrowserMiddleware(
  c: Context,
  next: Next,
): Promise<Response | void> {
  // Run in hosted mode and dev mode (for testing)
  if (!ENABLE_IN_APP_DETECTION) {
    return next();
  }

  // Only intercept GET requests (page navigations)
  if (c.req.method !== "GET") {
    return next();
  }

  const path = c.req.path;

  // Skip API routes and static assets
  if (path.startsWith("/api/") || path.startsWith("/assets/")) {
    return next();
  }

  const userAgent = c.req.header("User-Agent") || "";
  const appName = detectInAppBrowser(userAgent);

  if (!appName) {
    return next();
  }

  // Reconstruct the full original URL
  const url = c.req.url;
  const html = generateRedirectPage(url, appName);

  // Prevent intermediary caches from serving this page to normal browsers
  c.header("Cache-Control", "no-store");
  c.header("Vary", "User-Agent");

  return c.html(html);
}
