/** Hand-mirrored with inspector shared/swarm-grounding.ts; pin in mirrors.json. */
export const GROUNDING_LIMITS = {
  tools: 12,
  totalMs: 20_000,
  callMs: 8_000,
  resultBytes: 16_384,
  totalBytes: 49_152,
  entities: 25,
  identityChars: 200,
  factsChars: 1500,
  setupCalls: 8,
  setupMs: 90_000,
  setupSteps: 6,
  recordedCalls: 32,
} as const;
export const GROUNDING_PROMPT_VERSION = 1;
export type EntityIdentity = { kind: string; name?: string; id?: string };
export type SetupCall = {
  serverId: string;
  toolName: string;
  ok: boolean;
  isWrite: boolean;
  dispatched: boolean;
};
export type SetupEntity = EntityIdentity & {
  serverId: string;
  tool: string;
  evidence: { callIndex: number; objectPath: string };
  unprefixed?: boolean;
};
export type SetupReadiness =
  | 'ready'
  | 'not_needed'
  | 'not_assessed'
  | 'unavailable';
export type SetupRecord = {
  status: 'completed' | 'skipped' | 'failed';
  readiness: SetupReadiness;
  reason?: string;
  prefix: string;
  createdEntities: SetupEntity[];
  observedCreatedEntityCount: number;
  createdEntitiesTruncated?: boolean;
  unsupportedClaims: number;
  missing: { kind: string; why: string }[];
  toolCalls: SetupCall[];
  toolCallsTruncated?: boolean;
  writeCallsDispatched: number;
  retried: boolean;
  admittedWriteTools: string[];
  excludedToolCount: number;
  startedAt: number;
  durationMs: number;
  chatSessionId: string;
};
export type GroundingProbe = {
  serverId: string;
  serverName?: string;
  toolName: string;
  text: string;
  structuredContent?: unknown;
};
export type GroundingEvidence = EntityIdentity & {
  recordRef: string;
  source:
    | {
        kind: 'probe';
        serverId: string;
        toolName: string;
        probeIndex: number;
        objectPath: string;
      }
    | {
        kind: 'setup';
        serverId: string;
        toolName: string;
        callIndex: number;
        objectPath: string;
      };
};
export type TargetGrounding = {
  targetId: string;
  hostId: string;
  status: 'ok' | 'skipped' | 'failed';
  facts?: string;
  evidence?: GroundingEvidence[];
  unsupportedFacts?: number;
  probedTools: string[];
  capturedAt: number;
  model?: string;
  promptVersion?: number;
  reason?: string;
  setup?: SetupRecord;
};
export type GroundingReport = {
  projectId: string;
  runId: string;
  targetId: string;
  hostId: string;
  probes?: GroundingProbe[];
  probedTools?: string[];
  seedFacts?: SetupEntity[];
  skippedReason?: string;
  setup?: SetupRecord;
};
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
export function exactIdentity(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= GROUNDING_LIMITS.identityChars
    ? value
    : undefined;
}
export function parseJsonReport(text: string): unknown {
  try {
    return JSON.parse(
      text
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
    );
  } catch {
    return undefined;
  }
}
const PERSON_KINDS = new Set([
  'account',
  'author',
  'member',
  'owner',
  'person',
  'user',
]);
/** An account or human record. Personas must never learn a real person's name
 * or id as a workspace fact, so discovery drops these. Setup evidence keeps them:
 * a setup that creates a member must still be able to prove it did. */
export function isPersonRecord(obj: Record<string, unknown>): boolean {
  if (typeof obj.email === 'string') return true;
  const kind = exactIdentity(obj.kind) ?? exactIdentity(obj.type);
  return kind !== undefined && PERSON_KINDS.has(kind.toLowerCase());
}
/** Only entity objects and explicit result/list containers; never arbitrary prose or echoed inputs. */
export function extractEntityObjects(
  value: unknown,
  path = '$',
  depth = 0,
  options: { excludePeople?: boolean } = {}
): Array<EntityIdentity & { objectPath: string }> {
  if (depth > 8) return [];
  if (Array.isArray(value))
    return value
      .slice(0, 500)
      .flatMap((v, i) =>
        extractEntityObjects(v, `${path}[${i}]`, depth + 1, options)
      );
  const obj = record(value);
  if (!obj || obj.isError === true || obj.error !== undefined) return [];
  if (options.excludePeople && isPersonRecord(obj)) return [];
  const id = exactIdentity(obj.id);
  const name = exactIdentity(obj.name);
  if (id || name)
    return [
      {
        ...(id ? { id } : {}),
        ...(name ? { name } : {}),
        kind: exactIdentity(obj.kind) ?? exactIdentity(obj.type) ?? 'entity',
        objectPath: path,
      },
    ];
  const containers = [
    'data',
    'result',
    'results',
    'items',
    'created',
    'entity',
    'entities',
    'project',
    'projects',
    'server',
    'servers',
    'suite',
    'suites',
    'case',
    'cases',
    'run',
    'runs',
    'ticket',
    'tickets',
    'task',
    'tasks',
    'record',
    'records',
  ];
  return containers.flatMap((key) =>
    key in obj
      ? extractEntityObjects(obj[key], `${path}.${key}`, depth + 1, options)
      : []
  );
}
/** Setup envelopes with multiple possible subjects are ambiguous: a sibling project
 * may be an existing parent of the newly created suite. Prefer explicit creation
 * results, otherwise accept only one result container and never traverse references. */
function extractCreatedObjects(
  value: unknown,
  path: string,
  depth = 0
): Array<EntityIdentity & { objectPath: string }> {
  if (depth > 8) return [];
  if (Array.isArray(value))
    return value
      .slice(0, 500)
      .flatMap((entry, i) =>
        extractCreatedObjects(entry, `${path}[${i}]`, depth + 1)
      );
  const obj = record(value);
  if (!obj || obj.isError === true || obj.error !== undefined) return [];
  if (exactIdentity(obj.id) || exactIdentity(obj.name))
    return extractEntityObjects(obj, path);
  const primary = ['created', 'result', 'results', 'data'].filter(
    (key) => key in obj
  );
  const keys = primary.length
    ? primary
    : [
        'items',
        'entity',
        'entities',
        'project',
        'projects',
        'server',
        'servers',
        'suite',
        'suites',
        'case',
        'cases',
        'run',
        'runs',
        'ticket',
        'tickets',
        'task',
        'tasks',
        'record',
        'records',
      ].filter((key) => key in obj);
  const key =
    'created' in obj ? 'created' : keys.length === 1 ? keys[0] : undefined;
  return key
    ? extractCreatedObjects(obj[key], `${path}.${key}`, depth + 1)
    : [];
}
export function entitiesFromResult(
  result: unknown
): Array<EntityIdentity & { objectPath: string }> {
  const obj = record(result);
  if (!obj || obj.isError === true) return [];
  if (obj.structuredContent !== undefined)
    return extractCreatedObjects(obj.structuredContent, '$.structuredContent');
  if (Array.isArray(obj.content))
    return obj.content.flatMap((part, i) => {
      const block = record(part);
      return block?.type === 'text' && typeof block.text === 'string'
        ? extractCreatedObjects(parseJsonReport(block.text), `$.content[${i}]`)
        : [];
    });
  return extractCreatedObjects(obj, '$');
}
export function extractGroundingEvidence(
  probes: GroundingProbe[],
  seeds: SetupEntity[] = []
): GroundingEvidence[] {
  const candidates: GroundingEvidence[] = [];
  seeds.forEach((entity, i) =>
    candidates.push({
      kind: entity.kind,
      ...(entity.name ? { name: entity.name } : {}),
      ...(entity.id ? { id: entity.id } : {}),
      recordRef: `setup-${i}`,
      source: {
        kind: 'setup',
        serverId: entity.serverId,
        toolName: entity.tool,
        callIndex: entity.evidence.callIndex,
        objectPath: entity.evidence.objectPath,
      },
    })
  );
  probes.forEach((probe, probeIndex) => {
    const entries =
      probe.structuredContent !== undefined
        ? extractEntityObjects(probe.structuredContent, '$', 0, {
            excludePeople: true,
          })
        : extractEntityObjects(parseJsonReport(probe.text), '$', 0, {
            excludePeople: true,
          });
    entries.forEach(({ objectPath, ...entity }, i) =>
      candidates.push({
        ...entity,
        recordRef: `probe-${probeIndex}-${i}`,
        source: {
          kind: 'probe',
          serverId: probe.serverId,
          toolName: probe.toolName,
          probeIndex,
          objectPath,
        },
      })
    );
  });
  return candidates.slice(0, 500);
}
export function normalizeGroundingFacts(evidence: GroundingEvidence[]): {
  facts: string;
  evidence: GroundingEvidence[];
} {
  const lines: string[] = [];
  const retained: GroundingEvidence[] = [];
  const display = (value: string) => JSON.stringify(value).slice(1, -1);
  for (const entity of evidence.slice(0, GROUNDING_LIMITS.entities)) {
    const line = `- ${display(entity.kind)}: ${entity.name ? display(entity.name) : '(unnamed)'}${entity.id ? ` (id: ${display(entity.id)})` : ''}`;
    if ([...lines, line].join('\n').length > GROUNDING_LIMITS.factsChars) break;
    lines.push(line);
    retained.push(entity);
  }
  return { facts: lines.join('\n'), evidence: retained };
}
export function selectGroundingEvidence(
  output: string,
  candidates: GroundingEvidence[]
) {
  const parsed = record(parseJsonReport(output));
  if (
    !parsed ||
    !Array.isArray(parsed.recordRefs) ||
    Object.keys(parsed).some((key) => key !== 'recordRefs')
  )
    throw new Error('Invalid grounding selection');
  const selected: GroundingEvidence[] = [];
  let unsupportedFacts = 0;
  const seen = new Set<string>();
  for (const ref of parsed.recordRefs.slice(0, 500)) {
    const candidate =
      typeof ref === 'string'
        ? candidates.find((c) => c.recordRef === ref)
        : undefined;
    if (!candidate) {
      unsupportedFacts++;
      continue;
    }
    // Two tools often return the same entity (a project from both a list and an
    // overview). Identity is the id when present, otherwise kind + name.
    const identity = candidate.id
      ? `id:${candidate.id}`
      : `name:${candidate.kind}:${candidate.name ?? ''}`;
    if (!seen.has(identity)) selected.push(candidate);
    seen.add(identity);
  }
  return { ...normalizeGroundingFacts(selected), unsupportedFacts };
}
export function mayRunAfterSetup(
  setup: Pick<SetupRecord, 'status' | 'readiness' | 'reason'>
): boolean {
  return (
    (setup.status === 'completed' &&
      (setup.readiness === 'ready' || setup.readiness === 'not_needed')) ||
    (setup.status === 'skipped' &&
      setup.readiness === 'not_assessed' &&
      setup.reason === 'no_eligible_write_tools')
  );
}
export function validSetupState(
  setup: Pick<SetupRecord, 'status' | 'readiness' | 'reason'>
): boolean {
  return (
    mayRunAfterSetup(setup) ||
    ((setup.status === 'failed' || setup.status === 'completed') &&
      setup.readiness === 'unavailable')
  );
}
