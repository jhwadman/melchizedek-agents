/**
 * lib/observability/redact.ts — scrubs user text before it reaches the
 * telemetry ledger (adk_turns, adk_telemetry, adk_payloads; ADR 0026).
 *
 * The ledger keeps what a conversation said so a turn can be debugged and
 * judged; it should not keep the credentials or personal identifiers that
 * people paste into a chat. One redactor runs on every row the exporter
 * writes, over every text value except the identifier columns joins depend
 * on (ids, timestamps, model and agent names).
 *
 *   TELEMETRY_REDACT=secret                   (default) key-shaped credentials
 *   TELEMETRY_REDACT=secret,email,phone,card,ssn
 *   TELEMETRY_REDACT=off
 *   setTelemetryRedactor((text) => myDlp(text))   your own, in code
 *
 * Sessions and memory are NOT redacted: they must hold the conversation for
 * the agent to work. Erasure (`DELETE /memory`) is the answer there.
 */

export type Redactor = (text: string) => string;

/** Built-in patterns. Each match becomes `[redacted:<kind>]`. */
export const REDACTION_PATTERNS: Record<string, RegExp> = {
  secret: new RegExp(
    [
      'sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}', // Anthropic, OpenAI
      'AIza[0-9A-Za-z_-]{35}', // Google
      'xai-[A-Za-z0-9]{20,}', // xAI
      'gh[pousr]_[A-Za-z0-9]{30,}', // GitHub
      'xox[abprs]-[A-Za-z0-9-]{10,}', // Slack
      'AKIA[0-9A-Z]{16}', // AWS access key id
      'eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}', // a JWT
      '(?<=Bearer\\s)[A-Za-z0-9._~+/-]{20,}=*', // a bearer token in pasted headers
    ].join('|'),
    'g',
  ),
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  // Card and SSN run before phone, which would otherwise take their digits.
  card: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g,
  ssn: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g,
  // Never starts or ends inside a longer run of digit groups (an order number).
  phone: /(?<![\w.+]|\d[\s.-])\+?\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?![\w.]|[\s.-]\d)/g,
};

/** Passes the Luhn check: what separates a card number from any long number. */
function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** A redactor applying the named built-in patterns, in a fixed order. */
export function patternRedactor(kinds: string[]): Redactor {
  const unknown = kinds.filter((k) => !REDACTION_PATTERNS[k]);
  if (unknown.length) throw new Error(`TELEMETRY_REDACT: unknown kind(s) ${unknown.join(', ')} (use ${Object.keys(REDACTION_PATTERNS).join(', ')}, or off)`);
  const order = Object.keys(REDACTION_PATTERNS).filter((k) => kinds.includes(k));
  return (text) => {
    let out = text;
    for (const kind of order) {
      const re = new RegExp(REDACTION_PATTERNS[kind].source, REDACTION_PATTERNS[kind].flags);
      out = out.replace(re, (m) => (kind === 'card' && !luhn(m.replace(/\D/g, '')) ? m : `[redacted:${kind}]`));
    }
    return out;
  };
}

let custom: Redactor | null | undefined;

/** Plug in your own redactor (a DLP service, say); `null` turns redaction off. */
export function setTelemetryRedactor(redactor: Redactor | null): void {
  custom = redactor;
}

/** The redactor in force: the one set in code, else TELEMETRY_REDACT (default `secret`). */
export function telemetryRedactor(env: NodeJS.ProcessEnv = process.env): Redactor | undefined {
  if (custom !== undefined) return custom ?? undefined;
  const raw = (env.TELEMETRY_REDACT ?? 'secret').trim().toLowerCase();
  if (raw === 'off' || raw === 'none' || raw === 'false') return undefined;
  const kinds = raw === 'all' ? Object.keys(REDACTION_PATTERNS) : raw.split(',').map((s) => s.trim()).filter(Boolean);
  return patternRedactor(kinds);
}

/** Columns that identify and join rows: never rewritten. */
const IDENTIFIER_KEY = /(^|[_.])(id|ts|at|hash|version)$|[a-z](Id|ID)$|^(syndicate|agent|model|models|provider|route|stage|span_name|surface|surface_guild|surface_channel|surface_user|kind|reason|eval_[a-z]+|schema_version|error_code)$/;

/** Every text value in a row, redacted, except identifier columns. */
export function redactRow<T>(row: T, redactor: Redactor): T {
  const walk = (value: unknown, key: string | undefined): unknown => {
    if (typeof value === 'string') return key && IDENTIFIER_KEY.test(key) ? value : redactor(value);
    if (Array.isArray(value)) return value.map((v) => walk(v, key));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, k);
      return out;
    }
    return value;
  };
  return walk(row, undefined) as T;
}
