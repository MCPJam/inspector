export type TestingSurface = "explore" | "suites" | "runs";

export function readTestingSurfaceFromHash(hashValue: string): TestingSurface {
  const hash = hashValue.replace(/^#/, "");
  const [path, queryString] = hash.split("?");

  if (path.startsWith("/ci-evals")) {
    return "runs";
  }

  const params = new URLSearchParams(queryString || "");
  return params.get("surface") === "suites" ? "suites" : "explore";
}

export function withTestingSurface(
  hash: string,
  surface: Exclude<TestingSurface, "runs">,
): string {
  const normalizedHash = hash.startsWith("#") ? hash.slice(1) : hash;
  const [path, queryString] = normalizedHash.split("?");
  const params = new URLSearchParams(queryString || "");

  if (surface === "suites") {
    params.set("surface", "suites");
  } else {
    params.delete("surface");
  }

  const nextQuery = params.toString();
  return `#${path}${nextQuery ? `?${nextQuery}` : ""}`;
}
