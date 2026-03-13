export const VITE_PUBLIC_POSTHOG_KEY =
  "phc_dTOPniyUNU2kD8Jx8yHMXSqiZHM8I91uWopTMX6EBE9";
export const VITE_PUBLIC_POSTHOG_HOST = "https://us.i.posthog.com";

export const options = {
  api_host: VITE_PUBLIC_POSTHOG_HOST,
  capture_pageview: false,
  person_profiles: "always" as const,

  // Optional: Set static super properties that never change
  loaded: (posthog: any) => {
    posthog.register({
      environment: import.meta.env.MODE, // "development" or "production"
      platform: detectPlatform(),
    });
  },
};

// Check if PostHog should be disabled
export const isPostHogDisabled =
  import.meta.env.VITE_DISABLE_POSTHOG_LOCAL === "true";

// Conditional PostHog key and options
// Always use the real PostHog key so feature flags evaluate properly via /decide
export const getPostHogKey = () => VITE_PUBLIC_POSTHOG_KEY;
export const getPostHogOptions = () =>
  isPostHogDisabled
    ? {
        api_host: VITE_PUBLIC_POSTHOG_HOST,
        capture_pageview: false,
        person_profiles: "always" as const,
        // Disable event capture but keep /decide enabled for feature flag evaluation
        opt_out_capturing: true,
      }
    : options;

export function detectPlatform() {
  // Check if running in hosted/web mode
  if (import.meta.env.VITE_MCPJAM_HOSTED_MODE === "true") {
    return "web";
  }

  // Check if running in Docker
  const isDocker =
    import.meta.env.VITE_DOCKER === "true" ||
    import.meta.env.VITE_RUNTIME === "docker";

  if (isDocker) {
    return "docker";
  }

  // Check if Electron
  const isElectron = (window as any)?.isElectron;

  if (isElectron) {
    // Detect OS within Electron using userAgent
    const userAgent = navigator.userAgent.toLowerCase();

    if (userAgent.includes("mac") || userAgent.includes("darwin")) {
      return "mac";
    } else if (userAgent.includes("win")) {
      return "win";
    }
    return "electron"; // fallback
  }

  // npm package running in browser
  return "npm";
}

export function detectEnvironment() {
  return import.meta.env.ENVIRONMENT;
}
