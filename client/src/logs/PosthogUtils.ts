export const VITE_PUBLIC_POSTHOG_KEY =
  "phc_dTOPniyUNU2kD8Jx8yHMXSqiZHM8I91uWopTMX6EBE9";
export const VITE_PUBLIC_POSTHOG_HOST = "https://us.i.posthog.com";

export const options = {
  api_host: VITE_PUBLIC_POSTHOG_HOST,
  capture_pageview: false,
};

// Check if PostHog should be disabled
export const isPostHogDisabled =
  import.meta.env.VITE_DISABLE_POSTHOG_LOCAL === "true";

// Conditional PostHog key and options
export const getPostHogKey = () =>
  isPostHogDisabled ? "" : VITE_PUBLIC_POSTHOG_KEY;
export const getPostHogOptions = () => (isPostHogDisabled ? {} : options);
