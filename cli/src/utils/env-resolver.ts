import type { EnvironmentFile } from '../../schemas/environment-schema.js';

export function resolveEnvironmentVariables(env: EnvironmentFile): EnvironmentFile {
  return {
    ...env,
    mcpServers: Object.fromEntries(
      Object.entries(env.mcpServers).map(([name, config]) => [
        name,
        resolveServerConfig(config),
      ])
    ),
    providerApiKeys: env.providerApiKeys ? {
      anthropic: resolveTemplate(env.providerApiKeys.anthropic),
      openai: resolveTemplate(env.providerApiKeys.openai),
      deepseek: resolveTemplate(env.providerApiKeys.deepseek),
    } : undefined,
  };
}

function resolveServerConfig(config: any): any {
  if ('command' in config) {
    // STDIO server
    return {
      ...config,
      env: config.env ? Object.fromEntries(
        Object.entries(config.env).map(([key, value]) => [
          key,
          resolveTemplate(value as string),
        ])
      ) : undefined,
    };
  } else {
    // HTTP server
    return {
      ...config,
      headers: config.headers ? Object.fromEntries(
        Object.entries(config.headers).map(([key, value]) => [
          key,
          resolveTemplate(value as string),
        ])
      ) : undefined,
    };
  }
}

function resolveTemplate(value: string | undefined): string | undefined {
  if (!value) return value;
  
  return value.replace(/\$\{([^}]+)\}/g, (match, envVar) => {
    const resolved = process.env[envVar];
    if (resolved === undefined) {
      console.warn(`⚠️  Warning: Environment variable ${envVar} is not set`);
      return match;
    }
    return resolved;
  });
}