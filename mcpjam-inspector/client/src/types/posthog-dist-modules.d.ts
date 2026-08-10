// posthog-js ships its lazy-loadable feature bundles as plain dist files with
// no `exports` map and no type declarations. These side-effect imports only
// register onto `window.__PosthogExtensions__` (see
// lib/posthog-bundled-extensions.ts), so an untyped module declaration is the
// whole contract.
declare module "posthog-js/dist/posthog-recorder";
declare module "posthog-js/dist/surveys";
declare module "posthog-js/dist/exception-autocapture";
declare module "posthog-js/dist/dead-clicks-autocapture";
