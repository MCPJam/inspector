import { config } from "zod/v4/core";

// The trusted bridge runs under the App's HTTP policy, which excludes eval.
// Configure parsers before loading modules that construct bridge schemas.
config({ jitless: true });
