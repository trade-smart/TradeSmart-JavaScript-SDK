// Client configuration (sdk-behaviour 12, 3.4). Immutable; invalid values throw
// `ConfigurationError` at creation with a message that names the setting and never echoes the value.
import { ConfigurationError } from "./errors.js";
import { type Logger, noopLogger } from "./lib/log.js";
import { VERSION } from "./version.js";

const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
// Printable ASCII (space to ~): no control characters (CR/LF/tab/DEL) and no non-ASCII.
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** Every setting is optional; `undefined` means "not given" and keeps the default. */
export interface ClientConfigInit {
  baseUrl?: string | undefined;
  wsUrl?: string | undefined;
  authorizeUrl?: string | undefined;
  scriptMasterBaseUrl?: string | undefined;
  /** Seconds. */
  connectTimeout?: number | undefined;
  /** Seconds. */
  readTimeout?: number | undefined;
  maxRetries?: number | undefined;
  /** Seconds. */
  backoffBase?: number | undefined;
  /** Seconds. */
  backoffCap?: number | undefined;
  rateLimitMode?: "wait" | "raise" | undefined;
  /** Seconds an order waits for the client-side rate limit before `RateLimitError`. */
  orderRateLimitMaxWait?: number | undefined;
  /** Orders per second, 1 to 30; above 10 only with `algoId`. */
  orderRateLimitPerSecond?: number | undefined;
  /** Orders per rolling 60 s, 1 to 600, at least `orderRateLimitPerSecond`. */
  orderRateLimitPerMinute?: number | undefined;
  /** Exchange-approved algo ID, sent on every PlaceOrder and ModifyOrder unless the call gives its own. */
  algoId?: string | null | undefined;
  userAgent?: string | undefined;
  logPayloads?: boolean | undefined;
  checkTokenExpiry?: boolean | undefined;
  /** Seconds. */
  heartbeatInterval?: number | undefined;
  /** Seconds. */
  wsAuthTimeout?: number | undefined;
  /** `null` means unlimited. */
  reconnectMaxAttempts?: number | null | undefined;
  /** Seconds. */
  reconnectBackoffBase?: number | undefined;
  /** Seconds. */
  reconnectBackoffCap?: number | undefined;
  /** Seconds. */
  keepaliveExpiry?: number | undefined;
  maxConnections?: number | undefined;
  maxKeepaliveConnections?: number | undefined;
  streamBacklogLimit?: number | undefined;
  /** `HH:MM`, 24-hour, IST. */
  scriptMasterRefreshTime?: string | undefined;
  scriptMasterRecheckMinutes?: number | undefined;
  /** A non-empty path or `null` (the user cache folder). A leading `~` is expanded by the user of the setting. */
  instrumentsDir?: string | null | undefined;
  /** Where the library logs; default is a no-op logger. */
  logger?: Logger | undefined;
}

const DEFAULTS = {
  baseUrl: "https://v2api.tradesmartonline.in/NorenWClientAPIv2",
  wsUrl: "wss://v2api.tradesmartonline.in/NorenWSAPI/",
  authorizeUrl: "https://v2api.tradesmartonline.in/OAuthlogin/authorize/oauth",
  scriptMasterBaseUrl: "https://v2api.tradesmartonline.in",
  connectTimeout: 5,
  readTimeout: 10,
  maxRetries: 2,
  backoffBase: 0.5,
  backoffCap: 8,
  rateLimitMode: "wait",
  orderRateLimitMaxWait: 1,
  orderRateLimitPerSecond: 10,
  orderRateLimitPerMinute: 200,
  algoId: null,
  userAgent: `tradesmart-javascript/${VERSION}`,
  logPayloads: false,
  checkTokenExpiry: true,
  heartbeatInterval: 30,
  wsAuthTimeout: 10,
  reconnectMaxAttempts: 20,
  reconnectBackoffBase: 1,
  reconnectBackoffCap: 60,
  keepaliveExpiry: 50,
  maxConnections: 10,
  maxKeepaliveConnections: 5,
  streamBacklogLimit: 1000,
  scriptMasterRefreshTime: "07:00",
  scriptMasterRecheckMinutes: 15,
  instrumentsDir: null,
  logger: noopLogger,
} as const satisfies Resolved;

type Resolved = {
  -readonly [K in keyof ClientConfigInit]-?: Exclude<ClientConfigInit[K], undefined>;
};

/** The setting name in the messages: the contract's snake_case. */
function snake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Immutable settings shared by every client. Build one with `ClientConfig.create`. */
export class ClientConfig {
  readonly baseUrl!: string;
  readonly wsUrl!: string;
  readonly authorizeUrl!: string;
  readonly scriptMasterBaseUrl!: string;
  readonly connectTimeout!: number;
  readonly readTimeout!: number;
  readonly maxRetries!: number;
  readonly backoffBase!: number;
  readonly backoffCap!: number;
  readonly rateLimitMode!: "wait" | "raise";
  readonly orderRateLimitMaxWait!: number;
  readonly orderRateLimitPerSecond!: number;
  readonly orderRateLimitPerMinute!: number;
  readonly algoId!: string | null;
  readonly userAgent!: string;
  readonly logPayloads!: boolean;
  readonly checkTokenExpiry!: boolean;
  readonly heartbeatInterval!: number;
  readonly wsAuthTimeout!: number;
  readonly reconnectMaxAttempts!: number | null;
  readonly reconnectBackoffBase!: number;
  readonly reconnectBackoffCap!: number;
  readonly keepaliveExpiry!: number;
  readonly maxConnections!: number;
  readonly maxKeepaliveConnections!: number;
  readonly streamBacklogLimit!: number;
  readonly scriptMasterRefreshTime!: string;
  readonly scriptMasterRecheckMinutes!: number;
  readonly instrumentsDir!: string | null;
  readonly logger!: Logger;

  private constructor(values: Resolved) {
    Object.assign(this, values);
    Object.freeze(this);
  }

  /** Validate `init` against the defaults and return the frozen configuration. */
  static create(init: ClientConfigInit = {}): ClientConfig {
    const values: Record<string, unknown> = { ...DEFAULTS };
    for (const [key, value] of Object.entries(init)) {
      if (!Object.hasOwn(DEFAULTS, key))
        throw new ConfigurationError(`unknown setting ${snake(key)}`);
      if (value !== undefined) values[key] = value;
    }
    const c = values as Resolved;
    validate(c);
    c.baseUrl = c.baseUrl.replace(/\/+$/, "");
    return new ClientConfig(c);
  }
}

const SDK_TOKEN = `tradesmart-javascript/${VERSION}`;

/**
 * The `User-Agent` actually sent (§3.1): `cfg.userAgent` as is when it already contains
 * `tradesmart-javascript/<version>`, else with that token appended after a space.
 */
export function headerUserAgent(cfg: ClientConfig): string {
  if (cfg.userAgent.includes(SDK_TOKEN)) return cfg.userAgent;
  return `${cfg.userAgent} ${SDK_TOKEN}`.trim();
}

function fail(message: string): never {
  throw new ConfigurationError(message);
}

function validate(c: Resolved): void {
  for (const name of [
    "baseUrl",
    "wsUrl",
    "authorizeUrl",
    "scriptMasterBaseUrl",
    "userAgent",
    "scriptMasterRefreshTime",
  ] as const) {
    if (typeof c[name] !== "string") fail(`${snake(name)} must be a string`);
  }
  for (const name of ["logPayloads", "checkTokenExpiry"] as const) {
    if (typeof c[name] !== "boolean") fail(`${snake(name)} must be true or false`);
  }
  for (const name of ["baseUrl", "authorizeUrl", "scriptMasterBaseUrl"] as const) {
    if (!/^https?:\/\//.test(c[name])) fail(`${snake(name)} must start with http:// or https://`);
  }
  if (!/^wss?:\/\//.test(c.wsUrl)) fail("ws_url must start with ws:// or wss://");
  for (const name of [
    "connectTimeout",
    "readTimeout",
    "backoffBase",
    "backoffCap",
    "heartbeatInterval",
    "wsAuthTimeout",
    "reconnectBackoffBase",
    "reconnectBackoffCap",
    "keepaliveExpiry",
  ] as const) {
    // NaN, infinity and non-numbers (string, null, boolean ...) are rejected too.
    if (!isFiniteNumber(c[name]) || c[name] <= 0) {
      fail(`${snake(name)} must be a finite positive number`);
    }
  }
  for (const [name, minimum] of [
    ["maxConnections", 1],
    ["maxKeepaliveConnections", 1],
    ["streamBacklogLimit", 1],
    ["scriptMasterRecheckMinutes", 1],
    ["maxRetries", 0],
  ] as const) {
    // Integers only: a fraction, NaN, infinity or a boolean is rejected.
    if (!isInt(c[name]) || c[name] < minimum) {
      fail(`${snake(name)} must be an integer >= ${String(minimum)}`);
    }
  }
  const attempts = c.reconnectMaxAttempts;
  if (attempts !== null && (!isInt(attempts) || attempts < 0)) {
    fail("reconnect_max_attempts must be an integer >= 0 or null");
  }
  if (c.maxKeepaliveConnections > c.maxConnections) {
    fail("max_keepalive_connections must be <= max_connections");
  }
  if (!PRINTABLE_ASCII.test(c.userAgent)) {
    // Never echo the value: it may be an attempted header injection.
    fail("user_agent must contain only printable ASCII characters (no control characters)");
  }
  if (!HH_MM.test(c.scriptMasterRefreshTime)) {
    fail("script_master_refresh_time must be HH:MM (24-hour, IST)");
  }
  if (!isFiniteNumber(c.orderRateLimitMaxWait) || c.orderRateLimitMaxWait < 0) {
    fail("order_rate_limit_max_wait must be a finite number >= 0");
  }
  const perSecond = c.orderRateLimitPerSecond;
  if (!isInt(perSecond) || perSecond < 1 || perSecond > 30) {
    fail("order_rate_limit_per_second must be an integer from 1 to 30");
  }
  const perMinute = c.orderRateLimitPerMinute;
  if (!isInt(perMinute) || perMinute < 1 || perMinute > 600) {
    fail("order_rate_limit_per_minute must be an integer from 1 to 600");
  }
  if (perMinute < perSecond) {
    fail("order_rate_limit_per_minute must be at least order_rate_limit_per_second");
  }
  const algoId = c.algoId;
  if (algoId !== null && (typeof algoId !== "string" || algoId.trim() === "")) {
    fail("algo_id must be a non-blank string or null");
  }
  if (perSecond > 10 && algoId === null) {
    fail(
      "order_rate_limit_per_second above 10 needs algo_id (TradeSmart requires an algo ID for more than 10 orders per second)",
    );
  }
  const mode: unknown = c.rateLimitMode;
  if (mode !== "wait" && mode !== "raise") {
    fail("rate_limit_mode must be 'wait' or 'raise'");
  }
  const folder = c.instrumentsDir;
  if (folder !== null && (typeof folder !== "string" || folder.trim() === "")) {
    fail("instruments_dir must be a non-empty path or null");
  }
}
