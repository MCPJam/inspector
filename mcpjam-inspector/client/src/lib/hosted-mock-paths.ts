/**
 * Browser routes for a project's mock servers: creating one, reading one,
 * saving a version, and reading its forwarding policy. They go out through
 * `authFetch`, so without an entry in the hosted bearer allowlist the browser
 * sends no `Authorization` and the route answers "Bearer token required".
 */
export const HOSTED_MOCK_AUTH_PATH_PATTERNS = [
  /^\/api\/v1\/projects\/[^/]+\/mock-servers(\/[^/]+(\/(versions|forwarding-policy))?)?$/,
  /^\/api\/v1\/projects\/[^/]+\/mock-forwarding-policy$/,
];
