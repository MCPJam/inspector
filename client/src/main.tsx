import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import {
  getPostHogKey,
  getPostHogOptions,
  isPostHogDisabled,
} from "./logs/PosthogUtils.ts";
import { PostHogProvider } from "posthog-js/react";

const root = createRoot(document.getElementById("root")!);

if (isPostHogDisabled) {
  // Render without PostHog
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
} else {
  // Render with PostHog
  root.render(
    <StrictMode>
      <PostHogProvider apiKey={getPostHogKey()} options={getPostHogOptions()}>
        <App />
      </PostHogProvider>
    </StrictMode>,
  );
}
