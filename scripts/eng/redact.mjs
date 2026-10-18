/**
 * Strips credentials from text before it leaves the machine: session
 * records, decision comments, tool output, anything the outbox queues.
 *
 * It errs toward redacting. A session record is read by people who never
 * need the secret, and a replacement names the kind of value it removed, so
 * the record still reads. Each rule is a pattern and its replacement; the
 * header and assignment rules keep the name and drop only the value.
 */
const SECRET_NAME =
  'password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|credentials?';

const VALUE = `("[^"\\n]*"|'[^'\\n]*'|[^\\s,;}'"]+)`;

/** A value that points at a secret rather than holding one stays readable. */
const REFERENCE = /^["']?(?:\$|process\.env|env\.|<|\[REDACTED|\*+["']?$)/;

const keepReferences = (quote) => (match, name, value) =>
  REFERENCE.test(value) ? match : `${name}${quote}[REDACTED]${quote}`;

const RULES = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    '[REDACTED private key]',
  ],
  [
    /\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?:(bearer|basic|token|digest|negotiate)\s+)?[^\s"',;]+/gi,
    (_, name, scheme) => `${name}${scheme ? `${scheme} ` : ''}[REDACTED]`,
  ],
  [/\b((?:set-)?cookie["']?\s*[:=]\s*["']?)[^\r\n"']+/gi, '$1[REDACTED]'],
  // Credentials inside any URL: postgres://, mongodb+srv://, redis://, https://.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:)[^\s@/]+@/gi, '$1[REDACTED]@'],
  [
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g,
    '[REDACTED github token]',
  ],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[REDACTED slack token]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED aws key id]'],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g, '[REDACTED stripe key]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[REDACTED api key]'],
  [/\bAIza[A-Za-z0-9_-]{35}/g, '[REDACTED google key]'],
  [/\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g, '[REDACTED jwt]'],
  // Environment-style assignments: .env files, printenv, export lines.
  [
    /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)[A-Z0-9_]*\s*=\s*)(\[REDACTED[^\]]*\]|"[^"\n]*"|'[^'\n]*'|\S+)/g,
    keepReferences(''),
  ],
  // JSON, YAML and connection-string fields, and CLI flags.
  [
    new RegExp(
      `((?<![\\w-])["']?(?:${SECRET_NAME})["']?\\s*:\\s*)${VALUE}`,
      'gi'
    ),
    keepReferences('"'),
  ],
  [
    new RegExp(`((?<![\\w-])(?:${SECRET_NAME})\\s*=\\s*)${VALUE}`, 'gi'),
    keepReferences(''),
  ],
  [
    new RegExp(`(--(?:${SECRET_NAME})(?:=|\\s+))(\\S+)`, 'gi'),
    keepReferences(''),
  ],
];

export function redact(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
