// Side-effect module that main.tsx imports FIRST. Modules such as
// lib/oauth/mcp-oauth.ts save `window.fetch` when they load (and put it back
// after every OAuth flow), so fetch has to be wrapped before any of them are
// evaluated, or their requests would skip the tracker.
import { installFailedRequestTracker } from "./failed-request-tracker";

installFailedRequestTracker();
