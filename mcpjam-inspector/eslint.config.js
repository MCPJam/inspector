// @ts-check
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";

// One layer per directory. `shared` is loaded by the browser and by Node, so
// it can depend on neither side. The SDK is a package: a relative path into
// its source skips the entry points its consumers are held to.
// A `dir` target is relative to this file and a `specifier` target matches a
// bare specifier. A relative specifier is resolved against the importing file
// before it is classified, so `../shared/../client/x` from shared/ is caught
// and `../../client/../server/x` from server/ is not.
const SDK_BY_PATH = {
  dir: "../sdk/src",
  message:
    "Import the SDK by package name (`@mcpjam/sdk` or `@mcpjam/sdk/<subpath>`), not by a relative path into sdk/src.",
};
const SERVER_BY_PATH = {
  dir: "server",
  message:
    "Client and shared code cannot import the server. Move what both sides need into shared/.",
};
const CLIENT_BY_PATH = {
  dir: "client",
  message:
    "Server and shared code cannot import the client. Move what both sides need into shared/.",
};
const NODE_BUILTIN = {
  specifier: "^node:",
  message:
    "shared/ also runs in the browser, so it cannot import Node built-ins. Put this in server/.",
};
// Tests are left out: a parity test has to load both sides it compares.
const TESTS = ["**/__tests__/**", "**/*.test.{ts,tsx}"];
const ROOT = path.dirname(fileURLToPath(import.meta.url));
// no-restricted-imports matches the spelling of a specifier, not the module it
// names, and never sees import(). This rule resolves static imports,
// re-exports and literal import() alike. It is a plugin rule because
// no-restricted-syntax is already configured for server/routes, and a later
// config's options replace an earlier one's.
const layers = {
  rules: {
    "no-cross-layer-imports": {
      meta: { type: "problem", schema: false },
      create(context) {
        const fromDir = path.dirname(context.filename);
        const targets = context.options.map(({ dir, specifier, message }) => ({
          dir,
          specifier: specifier === undefined ? undefined : new RegExp(specifier),
          message,
        }));
        const check = (source) => {
          const spec =
            source?.type === "Literal"
              ? source.value
              : source?.type === "TemplateLiteral" &&
                  source.expressions.length === 0
                ? source.quasis[0].value.cooked
                : undefined;
          if (typeof spec !== "string") return;
          const target = spec.startsWith(".")
            ? path
                .relative(ROOT, path.resolve(fromDir, spec))
                .split(path.sep)
                .join("/")
            : undefined;
          const match = targets.find(({ dir, specifier }) =>
            specifier
              ? specifier.test(spec)
              : target !== undefined &&
                (target === dir || target.startsWith(`${dir}/`)),
          );
          if (match) context.report({ node: source, message: match.message });
        };
        return {
          ImportDeclaration: ({ source }) => check(source),
          ExportNamedDeclaration: ({ source }) => check(source),
          ExportAllDeclaration: ({ source }) => check(source),
          ImportExpression: ({ source }) => check(source),
        };
      },
    },
  },
};
const restrictImports = (...targets) => ({
  "layers/no-cross-layer-imports": ["error", ...targets],
});

// Violations that predate a rule are recorded in eslint-suppressions.json, so
// `npm run lint` fails only on new ones. After fixing some, run
// `npm run lint:prune` to drop their entries.
export default [
  {
    ignores: [
      "dist/**",
      "out/**",
      "node_modules/**",
      "coverage/**",
      "**/*.bundled.ts",
      "**/*.generated.ts",
    ],
  },
  {
    files: ["client/src/**/*.{ts,tsx}", "server/**/*.ts", "shared/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { layers },
    // The source carries disable comments for rules this config does not load
    // (`import/extensions`, `@typescript-eslint/*`). Reporting them as unused
    // would bury the rules below.
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
  {
    files: ["client/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    files: ["client/src/**/*.{ts,tsx}"],
    ignores: TESTS,
    rules: restrictImports(SERVER_BY_PATH, SDK_BY_PATH),
  },
  {
    files: ["server/**/*.ts"],
    ignores: TESTS,
    rules: restrictImports(CLIENT_BY_PATH, SDK_BY_PATH),
  },
  {
    files: ["shared/**/*.ts"],
    ignores: TESTS,
    rules: restrictImports(
      SERVER_BY_PATH,
      CLIENT_BY_PATH,
      SDK_BY_PATH,
      NODE_BUILTIN,
    ),
  },
  {
    files: ["server/routes/**/*.ts"],
    ignores: ["server/routes/web/**", ...TESTS],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CatchClause CallExpression[callee.type='MemberExpression'][callee.property.name='error'][callee.object.name='logger'], CatchClause CallExpression[callee.type='MemberExpression'][callee.property.name='error'][callee.object.property.name='logger']",
          message:
            "Report a route failure with reportRouteFailure(message, error, { source, hop }) from server/utils/route-error-report.ts. " +
            "It decides whose fault the failure is before Sentry hears of it and still writes the Axiom row; logger.error pages for every failure.",
        },
      ],
    },
  },
  {
    files: ["server/routes/web/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.object.name='logger'][callee.property.name=/^(warn|error|info)$/]",
          message:
            "Free-form logger.warn/error/info calls are not queryable in Axiom, so server/routes/web/ bans them. " +
            "Report a caught failure with reportRouteFailure(message, error, { source, hop }) " +
            "and everything else with logger.event(). " +
            "See server/utils/LOGGING.md for the typed event catalog.",
        },
      ],
    },
  },
];
