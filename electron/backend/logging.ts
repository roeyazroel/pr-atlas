/**
 * Small, provider-neutral structured logging helpers.
 *
 * This module deliberately has no dependency on the provider adapters. It may
 * be imported by those adapters without creating a cycle; callers can inject a
 * provider redactor when a stronger provider-specific boundary is available.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  runId?: string;
  provider?: string;
  task?: string;
  stage?: string;
}

export interface StructuredLogRecord extends LogContext {
  timestamp: string;
  level: LogLevel;
  event: string;
  metadata?: unknown;
}

export type LogRedactor = (value: string) => string;

export interface LogSerializationOptions {
  /** Maximum serialized size of one JSONL record, in UTF-8 bytes. */
  maxRecordBytes?: number;
  /** Maximum length of a string leaf before it receives a truncation marker. */
  maxStringLength?: number;
  /** Maximum object/array nesting depth. */
  maxDepth?: number;
  /** Maximum number of object properties or array entries at each level. */
  maxEntries?: number;
  /** Redacts provider- or application-specific strings before serialization. */
  redact?: LogRedactor;
}

export interface RunLoggerOptions extends LogSerializationOptions {
  /** Maximum number of records retained; the newest records win. */
  maxRecords?: number;
  /** Maximum total JSONL size retained, in UTF-8 bytes. */
  maxTotalBytes?: number;
  /** Alias accepted for integrations that call the bound total a maxBytes. */
  maxBytes?: number;
  /** Injectable clock for deterministic tests and reproducible fixtures. */
  now?: () => string;
}

export interface RunLogger {
  readonly records: readonly StructuredLogRecord[];
  log(
    level: LogLevel,
    event: string,
    metadata?: unknown,
    context?: LogContext,
  ): StructuredLogRecord | undefined;
  debug(event: string, metadata?: unknown, context?: LogContext): StructuredLogRecord | undefined;
  info(event: string, metadata?: unknown, context?: LogContext): StructuredLogRecord | undefined;
  warn(event: string, metadata?: unknown, context?: LogContext): StructuredLogRecord | undefined;
  error(event: string, metadata?: unknown, context?: LogContext): StructuredLogRecord | undefined;
  getRecords(): readonly StructuredLogRecord[];
  toJSONL(): string;
  /** Alias useful at file-writing call sites. */
  serialize(): string;
}

export const DEFAULT_MAX_LOG_RECORD_BYTES = 16 * 1024;
export const DEFAULT_MAX_LOG_RECORDS = 500;
export const DEFAULT_MAX_LOG_BYTES = 256 * 1024;
export const DEFAULT_MAX_LOG_STRING_LENGTH = 4 * 1024;
export const DEFAULT_MAX_LOG_DEPTH = 6;
export const DEFAULT_MAX_LOG_ENTRIES = 64;
export const DEFAULT_MAX_COMMAND_ARG_LENGTH = 512;

const REDACTED = "[REDACTED]";
const TRUNCATED = "…[truncated]";
const CIRCULAR = "[Circular]";

const SECRET_ENV_NAME =
  /(?:^|[_-])(?:API[_-]?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTHORIZATION|AUTH[_-]?TOKEN|CREDENTIALS?|PRIVATE[_-]?KEY)(?:$|[_-])/i;

const SECRET_KEY_NAMES = new Set([
  "apikey",
  "accesstoken",
  "authtoken",
  "authorization",
  "bearer",
  "clientsecret",
  "cookie",
  "credentials",
  "credential",
  "password",
  "passwd",
  "privatekey",
  "secret",
  "token",
]);

const SECRET_FLAG_NAMES = new Set([
  "apikey",
  "auth",
  "authorization",
  "authtoken",
  "clientsecret",
  "clientidtoken",
  "cookie",
  "credential",
  "credentials",
  "password",
  "passwd",
  "privatekey",
  "secret",
  "token",
]);

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? Math.floor(value)
    : fallback;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= TRUNCATED.length) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - TRUNCATED.length)}${TRUNCATED}`;
}

function compactKeyName(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSecretKey(value: string): boolean {
  if (SECRET_ENV_NAME.test(value)) return true;
  const compact = compactKeyName(value);
  if (SECRET_KEY_NAMES.has(compact)) return true;
  return [
    "apikey",
    "token",
    "secret",
    "password",
    "passwd",
    "credential",
    "authorization",
    "accesskey",
    "secretkey",
    "privatekey",
  ].some((part) => compact.endsWith(part));
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Conservative local redaction used by default. It intentionally mirrors the
 * provider boundary without importing agent.ts, so provider code can safely
 * import this logger. A caller with provider-specific rules can inject `redact`.
 */
export function redactLogString(value: string): string {
  const secretValues = Object.entries(process.env)
    .filter(([key, entry]) => entry && SECRET_ENV_NAME.test(key))
    .map(([, entry]) => entry as string)
    .filter((entry) => entry.length >= 4)
    .filter((entry, index, values) => values.indexOf(entry) === index)
    .sort((left, right) => right.length - left.length);

  let redacted = value;
  for (const secret of secretValues) {
    redacted = redacted.replace(new RegExp(escapedRegExp(secret), "g"), REDACTED);
  }

  redacted = redacted.replace(
    /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi,
    `$1${REDACTED}@`,
  );
  redacted = redacted.replace(
    /\b(?:Proxy-)?Authorization[ \t]*([=:])[ \t]*(?:Bearer|Basic|Token)[ \t]+(?!\[REDACTED\])[^\s,;}\])]+/gi,
    (_match, separator: string) => `Authorization${separator} ${REDACTED}`,
  );
  redacted = redacted.replace(
    /\b(?:Bearer|Basic|Token)[ \t]+(?!\[REDACTED\])[^\s,;}\])]+/gi,
    (match) => `${match.split(/[ \t]+/, 1)[0]} ${REDACTED}`,
  );
  redacted = redacted.replace(
    /(\b(?:[A-Za-z][A-Za-z0-9_.-]*(?:API[_-]?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTHORIZATION|CREDENTIALS?)|token|secret|password|authorization)\b[ \t]*(?:=|:)[ \t]*)(?!\[REDACTED\])(?!(?:Bearer|Basic|Token)[ \t]+\[REDACTED\])(?:"[^"]*"|'[^']*'|[^\s,;}\])]+)/gi,
    (_match, prefix: string) => `${prefix}${REDACTED}`,
  );
  return redacted;
}

interface NormalizedOptions {
  maxRecordBytes: number;
  maxStringLength: number;
  maxDepth: number;
  maxEntries: number;
  redact: LogRedactor;
}

function normalizeOptions(options: LogSerializationOptions = {}): NormalizedOptions {
  return {
    maxRecordBytes: positiveLimit(options.maxRecordBytes, DEFAULT_MAX_LOG_RECORD_BYTES),
    maxStringLength: positiveLimit(options.maxStringLength, DEFAULT_MAX_LOG_STRING_LENGTH),
    maxDepth: positiveLimit(options.maxDepth, DEFAULT_MAX_LOG_DEPTH),
    maxEntries: positiveLimit(options.maxEntries, DEFAULT_MAX_LOG_ENTRIES),
    redact: options.redact ?? redactLogString,
  };
}

interface SafeValueState {
  readonly options: NormalizedOptions;
  readonly ancestors: Set<object>;
}

function safeValue(value: unknown, state: SafeValueState, depth: number, key?: string): unknown {
  if (key !== undefined && isSecretKey(key)) return REDACTED;
  if (value === null) return null;
  if (typeof value === "string") {
    let redacted: string;
    try {
      redacted = state.options.redact(value);
    } catch {
      redacted = REDACTED;
    }
    return truncate(redacted, state.options.maxStringLength);
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "undefined") return undefined;
  if (typeof value === "function") return "[Function]";
  if (typeof value === "symbol") return String(value);

  if (depth >= state.options.maxDepth) return "[MaxDepth]";
  if (state.ancestors.has(value as object)) return CIRCULAR;
  state.ancestors.add(value as object);

  try {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? "[InvalidDate]" : value.toISOString();
    }
    if (value instanceof Error) {
      return {
        name: truncate(value.name, state.options.maxStringLength),
        message: safeValue(value.message, state, depth + 1, "message"),
        stack: safeValue(value.stack, state, depth + 1, "stack"),
      };
    }
    if (Array.isArray(value)) {
      const values = value
        .slice(0, state.options.maxEntries)
        .map((entry) => safeValue(entry, state, depth + 1));
      if (value.length > state.options.maxEntries) values.push("[MaxEntries]");
      return values;
    }

    const result: Record<string, unknown> = {};
    let keys: string[];
    try {
      keys = Object.keys(value as object).sort();
    } catch {
      return "[Unserializable]";
    }
    for (const property of keys.slice(0, state.options.maxEntries)) {
      try {
        const nested = safeValue(
          (value as Record<string, unknown>)[property],
          state,
          depth + 1,
          property,
        );
        if (nested !== undefined) result[property] = nested;
      } catch {
        result[property] = "[Unserializable]";
      }
    }
    if (keys.length > state.options.maxEntries) result["[truncated]"] = "[MaxEntries]";
    return result;
  } finally {
    state.ancestors.delete(value as object);
  }
}

function safeString(value: unknown, options: NormalizedOptions): unknown {
  return safeValue(value, { options, ancestors: new Set<object>() }, 0);
}

function contextValue(value: string | undefined, options: NormalizedOptions): string | undefined {
  if (value === undefined) return undefined;
  const safe = safeString(value, options);
  return typeof safe === "string" ? safe : String(safe);
}

function recordObject(record: StructuredLogRecord, options: NormalizedOptions): StructuredLogRecord {
  const output: StructuredLogRecord = {
    timestamp: contextValue(record.timestamp, options) ?? new Date(0).toISOString(),
    level: record.level,
    event: contextValue(record.event, options) ?? "unknown",
  };
  for (const key of ["runId", "provider", "task", "stage"] as const) {
    const value = contextValue(record[key], options);
    if (value !== undefined) output[key] = value;
  }
  if (record.metadata !== undefined) output.metadata = safeString(record.metadata, options);
  return output;
}

function jsonText(record: StructuredLogRecord): string {
  try {
    return JSON.stringify(record);
  } catch {
    return JSON.stringify({
      timestamp: new Date(0).toISOString(),
      level: "error",
      event: "log.serialization_failed",
      metadata: { truncated: true },
    });
  }
}

function serializedRecordBytes(record: StructuredLogRecord): number {
  // Include the JSONL line terminator in the bound; callers can write the
  // returned line directly without exceeding the configured record limit.
  return byteLength(jsonText(record)) + 1;
}

function fitRecord(record: StructuredLogRecord, options: NormalizedOptions): StructuredLogRecord {
  let fitted = record;
  if (serializedRecordBytes(fitted) <= options.maxRecordBytes) return fitted;

  if (fitted.metadata !== undefined) {
    fitted = { ...fitted, metadata: { truncated: true } };
    if (serializedRecordBytes(fitted) <= options.maxRecordBytes) return fitted;
  }

  const contextFields: Array<keyof LogContext | "event" | "timestamp"> = [
    "runId",
    "provider",
    "task",
    "stage",
    "event",
    "timestamp",
  ];
  for (const field of contextFields) {
    const current = fitted[field];
    if (typeof current !== "string") continue;
    const next = truncate(current, Math.max(1, Math.floor(current.length / 2)));
    fitted = { ...fitted, [field]: next };
    if (serializedRecordBytes(fitted) <= options.maxRecordBytes) return fitted;
  }

  // The configured bound is normally comfortably above this minimum shape;
  // this final fallback still keeps output valid JSON for unusually small test
  // or embedding limits.
  const minimal: StructuredLogRecord = {
    timestamp: "",
    level: fitted.level,
    event: "",
  };
  if (serializedRecordBytes(minimal) <= options.maxRecordBytes) return minimal;
  return { timestamp: "", level: fitted.level, event: "" };
}

/** Serialize one bounded, redacted record as one JSONL line. */
export function serializeLogRecord(
  record: StructuredLogRecord,
  options: LogSerializationOptions = {},
): string {
  const normalized = normalizeOptions(options);
  return `${jsonText(fitRecord(recordObject(record, normalized), normalized))}\n`;
}

function commandFlagName(value: string): string | undefined {
  const withoutAssignment = value.replace(/^--?/, "").split("=", 1)[0];
  if (withoutAssignment === value && !value.startsWith("-")) return undefined;
  return compactKeyName(withoutAssignment);
}

function commandAssignmentName(value: string): string | undefined {
  const equals = value.indexOf("=");
  if (equals <= 0) return undefined;
  return compactKeyName(value.slice(0, equals).replace(/^-+/, ""));
}

function isSecretFlag(value: string): boolean {
  const name = commandFlagName(value);
  return name !== undefined && (SECRET_FLAG_NAMES.has(name) || isSecretKey(name));
}

/**
 * Redact command arguments without changing their order or shape. Secret flag
 * values are replaced as a separate argv item, assignments retain their key,
 * and all remaining values are bounded and passed through the string redactor.
 */
export function redactCommandArgv(
  argv: readonly string[],
  options: { maxArgLength?: number; redact?: LogRedactor } = {},
): string[] {
  const maxArgLength = positiveLimit(options.maxArgLength, DEFAULT_MAX_COMMAND_ARG_LENGTH);
  const redact = options.redact ?? redactLogString;
  const result: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const original = String(argv[index]);
    if (isSecretFlag(original) && !original.includes("=")) {
      result.push(truncate(original, maxArgLength));
      if (index + 1 < argv.length) {
        result.push(REDACTED);
        index += 1;
      }
      continue;
    }

    const assignment = commandAssignmentName(original);
    if (
      assignment !== undefined &&
      (SECRET_FLAG_NAMES.has(assignment) || isSecretKey(assignment))
    ) {
      result.push(truncate(`${original.slice(0, original.indexOf("=") + 1)}${REDACTED}`, maxArgLength));
      continue;
    }

    let redacted: string;
    try {
      redacted = redact(original);
    } catch {
      redacted = REDACTED;
    }
    result.push(truncate(redacted, maxArgLength));
  }
  return result;
}

function loggerOptions(options: RunLoggerOptions): {
  serialization: NormalizedOptions;
  maxRecords: number;
  maxTotalBytes: number;
  now: () => string;
} {
  const maxTotalBytes = positiveLimit(
    options.maxTotalBytes ?? options.maxBytes,
    DEFAULT_MAX_LOG_BYTES,
  );
  const serialization = normalizeOptions({
    ...options,
    maxRecordBytes: Math.min(
      positiveLimit(options.maxRecordBytes, DEFAULT_MAX_LOG_RECORD_BYTES),
      maxTotalBytes,
    ),
  });
  return {
    serialization,
    maxRecords: positiveLimit(options.maxRecords, DEFAULT_MAX_LOG_RECORDS),
    maxTotalBytes,
    now: options.now ?? (() => new Date().toISOString()),
  };
}

/** Create a bounded logger whose output is directly suitable for logs.jsonl. */
export function createRunLogger(
  context: LogContext = {},
  options: RunLoggerOptions = {},
): RunLogger {
  const settings = loggerOptions(options);
  const records: StructuredLogRecord[] = [];
  let totalBytes = 0;

  const removeOldestUntilBounded = (): void => {
    while (records.length > settings.maxRecords || totalBytes > settings.maxTotalBytes) {
      const removed = records.shift();
      if (!removed) break;
      totalBytes -= byteLength(serializeLogRecord(removed, settings.serialization));
    }
  };

  const append = (
    level: LogLevel,
    event: string,
    metadata?: unknown,
    overrides?: LogContext,
  ): StructuredLogRecord | undefined => {
    const raw: StructuredLogRecord = {
      timestamp: settings.now(),
      level,
      event,
      ...(metadata === undefined ? {} : { metadata }),
      ...context,
      ...overrides,
    };
    const normalized = fitRecord(recordObject(raw, settings.serialization), settings.serialization);
    const lineBytes = byteLength(serializeLogRecord(normalized, settings.serialization));
    if (lineBytes > settings.maxTotalBytes) return undefined;
    records.push(normalized);
    totalBytes += lineBytes;
    removeOldestUntilBounded();
    return normalized;
  };

  const logger: RunLogger = {
    get records() {
      return records.slice();
    },
    log: append,
    debug: (event, metadata, overrides) => append("debug", event, metadata, overrides),
    info: (event, metadata, overrides) => append("info", event, metadata, overrides),
    warn: (event, metadata, overrides) => append("warn", event, metadata, overrides),
    error: (event, metadata, overrides) => append("error", event, metadata, overrides),
    getRecords: () => records.slice(),
    toJSONL: () => records.map((record) => serializeLogRecord(record, settings.serialization)).join(""),
    serialize: () => records.map((record) => serializeLogRecord(record, settings.serialization)).join(""),
  };
  return logger;
}
