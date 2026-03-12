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
export const getPostHogKey = () =>
  isPostHogDisabled ? "phdev" : VITE_PUBLIC_POSTHOG_KEY;
export const getPostHogOptions = () =>
  isPostHogDisabled
    ? {
        api_host: "https://internal-t.posthog.com",
        opt_out_capturing: true,
        disable_external_dependency_loading: true,
        advanced_disable_decide: true,
        // Bootstrap all feature flags as enabled so PostHog considers flags "loaded"
        // and useFeatureFlagEnabled() returns true for gated UI in dev mode
        bootstrap: {
          featureFlags: {
            "ci-evals-enabled": true,
            "mcpjam-learning": true,
          },
        },
        loaded: (posthog: any) => {
          // In dev mode, treat all feature flags as enabled
          posthog.isFeatureEnabled = () => true;
          posthog.getFeatureFlag = () => true;
        },
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
