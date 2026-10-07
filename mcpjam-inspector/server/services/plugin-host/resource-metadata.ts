/** Remove both historical and specified spellings of the host-owned path. */
export function stripPluginResourcePath(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized = structuredClone(metadata);
  delete sanitized["openai/resource.path"];
  const resource = sanitized["openai/resource"];
  if (resource && typeof resource === "object" && !Array.isArray(resource)) {
    const fields = resource as Record<string, unknown>;
    if (Object.hasOwn(fields, "path")) {
      delete fields.path;
      if (!Object.keys(fields).length) delete sanitized["openai/resource"];
    }
  }
  return sanitized;
}

/** Only a trusted resource grant supplies the path; other metadata survives. */
export function pluginResourceToolMetadata(
  metadata: Record<string, unknown>,
  privatePath?: string,
): Record<string, unknown> {
  const sanitized = stripPluginResourcePath(metadata);
  if (privatePath !== undefined) {
    const resource = sanitized["openai/resource"];
    sanitized["openai/resource"] = {
      ...(resource && typeof resource === "object" && !Array.isArray(resource)
        ? resource
        : {}),
      path: privatePath,
    };
  }
  return sanitized;
}
