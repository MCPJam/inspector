// The driver sends synthetic credentials over HTTP. Package lifecycle scripts
// and the Inspector process do not need the monitor/publisher's credentials.
export function childEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        !/^(CANARY_|SLACK_|CF_ACCESS_|SENTRY_AUTH_TOKEN$|NODE_AUTH_TOKEN$|GH_TOKEN$|GITHUB_TOKEN$)/.test(
          key
        )
    )
  );
}
