// `fromEnv` resolution (sdk-behaviour 6.4): client id, token, keys and the token file from the
// TRADESMART_* variables and the saved login. Every value is stripped; a blank one counts as unset.
// Errors name the problem and the login command, never a token or the file's contents.
import os from "node:os";
import { AccessToken, LOGIN_HINT } from "./auth.js";
import { AuthenticationError, ConfigurationError } from "./errors.js";
import {
  defaultTokenFilePath,
  readTokenFile,
  TokenFileError,
  type StoredLogin,
} from "./token-store/token-file.js";

/** What `TradeSmart.fromEnv` and `TradeSmartStream.fromEnv` need to build a client. */
export interface ResolvedEnv {
  clientId: string;
  /** The env token (a string), the saved login's token, or `null` (an app key can log in). */
  token: string | AccessToken | null;
  appKey: string | null;
  secretKey: string | null;
  tokenFile: string;
  /** Why there is no token when `token` is `null` (never secret); `null` otherwise. */
  missingTokenReason: string | null;
}

export interface ResolveOptions {
  kind: "client" | "stream";
  platform?: NodeJS.Platform;
  now?: Date;
  /** Default true: an expired saved login is not used. */
  checkTokenExpiry?: boolean;
}

function value(env: NodeJS.ProcessEnv, name: string): string | null {
  const text = (env[name] ?? "").trim();
  return text === "" ? null : text;
}

/** Resolve the client id, token, keys and token file as the 6.4 table says. */
export function resolveFromEnv(env: NodeJS.ProcessEnv, opts: ResolveOptions): ResolvedEnv {
  const now = opts.now ?? new Date();
  const check = opts.checkTokenExpiry ?? true;
  const isClient = opts.kind === "client";
  const tokenFile = defaultTokenFilePath(
    env,
    opts.platform ?? process.platform,
    os.homedir(),
    process.cwd(),
  );

  let clientId = value(env, "TRADESMART_CLIENT_ID");
  let token: string | AccessToken | null = value(env, "TRADESMART_ACCESS_TOKEN");
  const appKey = isClient ? value(env, "TRADESMART_APP_KEY") : null;
  if (token !== null && clientId === null) {
    // Never pair a token from the environment with the saved login's client id.
    throw new ConfigurationError(
      "TRADESMART_ACCESS_TOKEN is set but TRADESMART_CLIENT_ID is not; set both, or " +
        `unset TRADESMART_ACCESS_TOKEN and ${LOGIN_HINT} to use the saved login`,
    );
  }

  let saved: StoredLogin | null = null;
  let problem = `there is no saved login at ${tokenFile}`;
  if (clientId === null || token === null) {
    try {
      saved = readTokenFile(tokenFile, now);
    } catch (error) {
      if (!(error instanceof TokenFileError)) throw error;
      problem = error.message;
    }
  }
  if (clientId === null) {
    if (saved === null) {
      throw new ConfigurationError(`TRADESMART_CLIENT_ID is not set and ${problem}; ${LOGIN_HINT}`);
    }
    clientId = saved.clientId;
  }
  let expired = false;
  if (token === null && saved !== null) {
    if (saved.clientId.toLowerCase() !== clientId.toLowerCase()) {
      problem = `the saved login at ${tokenFile} is for a different client id`;
    } else if (check && saved.accessToken.isExpired(now)) {
      expired = true;
      problem =
        `the saved login at ${tokenFile} expired at ${saved.accessToken.expiresAt.toISOString()} ` +
        "(tokens are valid until 06:00 IST)";
    } else {
      token = saved.accessToken;
    }
  }
  if (token === null && appKey === null) {
    if (expired) {
      throw new AuthenticationError(`No usable access token: ${problem}; ${LOGIN_HINT}`, {
        endpoint: "",
        httpStatus: null,
      });
    }
    throw new ConfigurationError(
      `No access token: TRADESMART_ACCESS_TOKEN is not set and ${problem}; ${LOGIN_HINT}`,
    );
  }
  return {
    clientId,
    token,
    appKey,
    secretKey: isClient ? value(env, "TRADESMART_SECRET_KEY") : null,
    tokenFile,
    missingTokenReason: token === null ? problem : null,
  };
}
