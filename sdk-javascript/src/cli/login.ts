// The `login` command (sdk-behaviour 6.6-6.7), the JavaScript twin of `python -m tradesmart login`.
// It never prints the access token, the secret key, the checksum or the login code.
import { existsSync, realpathSync } from "node:fs";
import nodePath from "node:path";
import { TradeSmart } from "../client.js";
import { TradeSmartError } from "../errors.js";
import { signupUrl } from "../lib/links.js";
import { IST_OFFSET_MS } from "../lib/time.js";
import {
  KEY_FILE_NAME,
  KeyFileError,
  keyFilePath,
  readSavedKeys,
  saveKeys,
} from "../token-store/key-file.js";
import { defaultTokenFilePath, writeTokenFile } from "../token-store/token-file.js";
import { LOOPBACK, PROG, type Command } from "./args.js";
import {
  CALLBACK_PATH,
  DEFAULT_CALLBACK_TIMEOUT_MS,
  extractCode,
  startCallbackServer,
  type CallbackServer,
} from "./callback.js";
import { CliCancelled, errnoReason, type CliIo, type ExitCode } from "./io.js";

type LoginCommand = Extract<Command, { command: "login" }>;

const ENV_VAR = "TRADESMART_TOKEN_FILE";

/** A missing or invalid setting: exit code 2. */
export class UsageError extends Error {}

// ----- paths and shell quoting ------------------------------------------------------------

function pathModule(platform: NodeJS.Platform): typeof nodePath.posix {
  return platform === "win32" ? nodePath.win32 : nodePath.posix;
}

/** The token file in use: the option (`~` expanded, made absolute), else the default. */
export function tokenFileOf(io: CliIo, option: string | undefined): string {
  if (option === undefined || option === "") {
    return defaultTokenFilePath(io.env, io.platform, io.home, io.cwd);
  }
  const p = pathModule(io.platform);
  let expanded = option;
  if (option === "~") expanded = io.home;
  else if (option.startsWith("~/") || (io.platform === "win32" && option.startsWith("~\\"))) {
    expanded = p.join(io.home, option.slice(2));
  }
  return p.resolve(io.cwd, expanded);
}

// PowerShell also treats the typographic quotes as quote characters.
const PS_SINGLE_QUOTES = "'‘’‚‛";
const PS_DOUBLE_QUOTES = '"“”„';

function posixQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export function powershellQuote(text: string): string {
  let quoted = text;
  for (const quote of PS_SINGLE_QUOTES) quoted = quoted.replaceAll(quote, quote + quote);
  return `'${quoted}'`;
}

/** Whether `text` survives double quotes in cmd.exe (`%` always expands there). */
function cmdSafe(text: string): boolean {
  return !text.includes("%") && !text.includes('"');
}

/** Commands setting `TRADESMART_TOKEN_FILE` for each shell of `platform`. */
export function envHints(path: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [`export ${ENV_VAR}=${posixQuote(path)}`];
  const cmd = cmdSafe(path)
    ? `set "${ENV_VAR}=${path}"`
    : "(this path cannot be quoted safely for cmd; use PowerShell)";
  return [`PowerShell: $env:${ENV_VAR} = ${powershellQuote(path)}`, `cmd:        ${cmd}`];
}

/** `path` quoted for a command line of `platform`; the flag is true if PowerShell-only. */
export function commandArg(path: string, platform: NodeJS.Platform): [string, boolean] {
  if (platform !== "win32") return [posixQuote(path), false];
  const expands = Array.from("$`" + PS_DOUBLE_QUOTES).some((c) => path.includes(c));
  if (cmdSafe(path) && !expands) return [`"${path}"`, false];
  return [powershellQuote(path), true];
}

/** `text` as one command-line argument: as is when plain, else quoted for this platform. */
export function quotedArg(text: string, platform: NodeJS.Platform): string {
  return /^[A-Za-z0-9_.-]+$/.test(text) ? text : commandArg(text, platform)[0];
}

/** `<prog> logout --forget-keys`, naming `path` when it is not the default token file. */
export function forgetCommand(io: CliIo, path: string): string {
  let command = `${PROG} logout`;
  if (path !== defaultTokenFilePath(io.env, io.platform, io.home, io.cwd)) {
    command += ` --token-file ${commandArg(path, io.platform)[0]}`;
  }
  return `${command} --forget-keys`;
}

/** Why the keys file is refused: a link to another environment's keys file, else `null`. */
export function otherEnvironmentKeys(keysPath: string): string | null {
  let real: string;
  try {
    real = realpathSync(keysPath);
  } catch {
    return null; // not there (yet): nothing to follow
  }
  const name = nodePath.basename(real).toLowerCase();
  if (name !== KEY_FILE_NAME && name.endsWith(`-${KEY_FILE_NAME}`)) {
    return (
      `${keysPath} is a link to another environment's saved keys (${nodePath.basename(real)}); ` +
      "remove the link (each environment keeps its own keys)."
    );
  }
  return null;
}

// ----- prompting ---------------------------------------------------------------------------

/** Race a promise against the interrupt signal. */
function interruptible<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new CliCancelled());
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("failed"));
      },
    );
  });
}

function ask(io: CliIo, question: string, echo: boolean): Promise<string | null> {
  return interruptible(io.prompt(question, { echo }), io.interrupt);
}

function nonBlankEnv(io: CliIo, name: string): string | null {
  const value = io.env[name];
  return value === undefined || value === "" ? null : value;
}

// ----- keys --------------------------------------------------------------------------------

type Source = "saved" | "typed" | "environment";

interface Keys {
  appKey: string;
  secretKey: string;
  appKeySource: Source;
  secretKeySource: Source;
}

const anySaved = (keys: Keys): boolean =>
  keys.appKeySource === "saved" || keys.secretKeySource === "saved";

async function resolveKeys(
  io: CliIo,
  clientId: string,
  keysPath: string,
  appKeyOption: string | undefined,
  forget: string,
): Promise<Keys> {
  const found: Record<"appKey" | "secretKey", { value: string; source: Source } | null> = {
    appKey: appKeyOption === undefined ? null : { value: appKeyOption, source: "typed" },
    secretKey: null,
  };
  const names = { appKey: "TRADESMART_APP_KEY", secretKey: "TRADESMART_SECRET_KEY" } as const;
  for (const name of ["appKey", "secretKey"] as const) {
    const value = nonBlankEnv(io, names[name]);
    if (found[name] === null && value !== null) found[name] = { value, source: "environment" };
  }
  if (found.appKey === null || found.secretKey === null) {
    try {
      const saved = await readSavedKeys(keysPath, clientId);
      if (saved !== null) {
        if (found.appKey === null && saved.appKey !== null) {
          found.appKey = { value: saved.appKey, source: "saved" };
        }
        if (found.secretKey === null && saved.secretKey !== null) {
          found.secretKey = { value: saved.secretKey, source: "saved" };
        }
      }
    } catch (error) {
      if (!(error instanceof KeyFileError)) throw error;
      throw new UsageError(
        `Cannot log in with saved keys: ${error.message}. Remove that file with ` +
          `\`${forget}\` (it removes every saved key there and the saved login), ` +
          `or set ${names.appKey} and ${names.secretKey}.`,
      );
    }
  }
  const labels = { appKey: "app key", secretKey: "secret key" } as const;
  for (const name of ["appKey", "secretKey"] as const) {
    if (found[name] !== null) continue;
    const typed = await ask(
      io,
      `${labels[name][0]?.toUpperCase() ?? ""}${labels[name].slice(1)}: `,
      false,
    );
    if (typed === null) {
      const how = name === "appKey" ? `pass --app-key or set ${names[name]}` : `set ${names[name]}`;
      throw new UsageError(`No ${labels[name]} given: ${how}.`);
    }
    found[name] = { value: typed, source: "typed" };
  }
  const app = found.appKey as { value: string; source: Source };
  const secret = found.secretKey as { value: string; source: Source };
  const appKey = app.value.trim();
  const secretKey = secret.value.trim();
  if (appKey === "") throw new UsageError("The app key must not be empty.");
  if (secretKey === "") throw new UsageError("The secret key must not be empty.");
  return { appKey, secretKey, appKeySource: app.source, secretKeySource: secret.source };
}

function savedWhat(keys: Keys): string {
  return [
    ...(keys.appKeySource === "saved" ? ["App Key"] : []),
    ...(keys.secretKeySource === "saved" ? ["Secret key"] : []),
  ].join(" and ");
}

/** After a failed login: the saved keys may be wrong; say how to forget them (no loop). */
function savedKeysHint(io: CliIo, keys: Keys, clientId: string, keysPath: string, forget: string) {
  if (!anySaved(keys)) return;
  io.stderr(
    `The keys saved for ${clientId} in ${keysPath} were used. If they are wrong or were ` +
      `changed on the API Dashboard, forget them with ` +
      `\`${forget} --client-id ${quotedArg(clientId, io.platform)}\` and log in again.`,
  );
}

/** Save the typed keys (never ones from the environment) after a successful login. */
async function rememberKeys(
  io: CliIo,
  keys: Keys,
  clientId: string,
  keysPath: string,
  forget: string,
): Promise<void> {
  const given: { appKey?: string; secretKey?: string } = {};
  if (keys.appKeySource === "typed") given.appKey = keys.appKey;
  if (keys.secretKeySource === "typed") given.secretKey = keys.secretKey;
  if (given.appKey === undefined && given.secretKey === undefined) return;
  try {
    await saveKeys(keysPath, clientId, given);
  } catch (error) {
    const reason = error instanceof KeyFileError ? error.message : errnoReason(error);
    io.stderr(
      `The keys could not be saved to ${keysPath} (${reason}); the next login asks for them again.`,
    );
    return;
  }
  const what = [
    ...(given.appKey === undefined ? [] : ["App Key"]),
    ...(given.secretKey === undefined ? [] : ["Secret key"]),
  ].join(" and ");
  io.stdout(
    `Saved the ${what} for ${clientId} to ${keysPath} (readable only by you, not encrypted); ` +
      "the next login uses them.",
  );
  io.stdout(`Forget them with \`${forget} --client-id ${quotedArg(clientId, io.platform)}\`.`);
}

// ----- the code ----------------------------------------------------------------------------

async function pasteCode(io: CliIo): Promise<string | null> {
  io.stdout(
    "Paste the `code` from the address bar after logging in (or the whole URL) and press Enter.",
  );
  const pasted = await ask(io, "code or URL: ", true);
  return pasted === null ? null : extractCode(pasted);
}

/** The authorisation code: browser + local callback first, then a pasted code or URL. */
async function receiveCode(io: CliIo, url: string, command: LoginCommand): Promise<string | null> {
  const { port, listenHost } = command;
  if (command.noBrowser) {
    io.stdout("Open this URL in a browser and log in:");
    io.stdout(url);
    return pasteCode(io);
  }
  if (!listenHost.startsWith("127.")) {
    io.stderr(
      `Warning: listening on ${listenHost}:${String(port)}. Anyone who can reach that address ` +
        "can deliver a login code; use --listen-host only inside a container whose port is " +
        `published to 127.0.0.1 (for example -p 127.0.0.1:${String(port)}:${String(port)}). ` +
        "The account check still refuses a token issued to another account.",
    );
  }
  let server: CallbackServer | null = null;
  try {
    server = await startCallbackServer(listenHost, port);
  } catch (error) {
    io.stderr(
      `Cannot listen on ${listenHost}:${String(port)} (${errnoReason(error)}); paste the code instead.`,
    );
  }
  try {
    if (await interruptible(io.openBrowser(url), io.interrupt)) {
      io.stdout("Your browser shows the TradeSmart login page; log in there.");
    } else if (server !== null) {
      io.stdout(
        "Open this URL in your browser and log in; this window continues by itself " +
          "after the redirect.",
      );
      io.stdout(url);
    } else {
      io.stdout("Open this URL in a browser and log in:");
      io.stdout(url);
    }
    if (server !== null) {
      const timeout = io.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
      io.stdout(
        `Waiting up to ${String(Math.round(timeout / 1000))} s for the redirect to ` +
          `http://${LOOPBACK}:${String(port)}${CALLBACK_PATH} ...`,
      );
      const code = await server.waitForCode(timeout, io.interrupt);
      if (code !== null) return code;
      io.stderr(
        `No redirect received in time. If no browser opened, run \`${PROG} login --no-browser\`.`,
      );
    }
  } finally {
    await server?.close();
  }
  return pasteCode(io);
}

// ----- the command -------------------------------------------------------------------------

async function setting(
  io: CliIo,
  value: string | undefined,
  envName: string,
  label: string,
  flag: string,
  beforeAsk?: () => void,
): Promise<string> {
  let result = value ?? nonBlankEnv(io, envName);
  if (result === null) {
    beforeAsk?.();
    result = await ask(io, `${label[0]?.toUpperCase() ?? ""}${label.slice(1)}: `, true);
    if (result === null) {
      throw new UsageError(`No ${label} given: pass ${flag} or set ${envName}.`);
    }
  }
  result = result.trim();
  if (result === "") throw new UsageError(`The ${label} must not be empty.`);
  return result;
}

/** Run `login`; returns the exit code. */
export async function login(io: CliIo, command: LoginCommand): Promise<ExitCode> {
  const path = tokenFileOf(io, command.tokenFile);
  const keysPath = keyFilePath(path);
  const forget = forgetCommand(io, path);
  const problem = otherEnvironmentKeys(keysPath);
  if (problem !== null) {
    io.stderr(`Cannot use the saved keys: ${problem}`);
    return 2;
  }
  // A newcomer may have no account yet; a returning user (a saved token or saved keys) is not told.
  const firstLogin = !existsSync(path) && !existsSync(keysPath);
  let clientId: string;
  let keys: Keys;
  try {
    clientId = await setting(
      io,
      command.clientId,
      "TRADESMART_CLIENT_ID",
      "client id",
      "--client-id",
      firstLogin
        ? () => {
            io.stdout(`No TradeSmart account yet? Open one at ${signupUrl("cli")}`);
          }
        : undefined,
    );
    keys = await resolveKeys(io, clientId, keysPath, command.appKey, forget);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(error.message);
    return 2;
  }
  if (anySaved(keys))
    io.stdout(`Using the ${savedWhat(keys)} saved for ${clientId} in ${keysPath}.`);

  const client = new TradeSmart(clientId, {
    appKey: keys.appKey,
    secretKey: keys.secretKey,
    ...(io.config === undefined ? {} : { config: io.config }),
    ...(io.httpDispatcher === undefined ? {} : { httpDispatcher: io.httpDispatcher }),
  });
  let token;
  try {
    const code = await receiveCode(io, client.loginUrl(), command);
    if (code === null) {
      io.stderr(`No authorisation code received; run \`${PROG} login\` again.`);
      savedKeysHint(io, keys, clientId, keysPath, forget);
      return 1;
    }
    try {
      // Never retried: the code is single-use.
      token = await client.generateSession(code, io.interrupt ? { signal: io.interrupt } : {});
    } catch (error) {
      if (!(error instanceof TradeSmartError) || io.interrupt?.aborted === true) throw error;
      io.stderr(`Login failed: ${error.message}`); // SDK messages never contain secrets
      savedKeysHint(io, keys, clientId, keysPath, forget);
      return 1;
    }
  } finally {
    await client.close();
  }
  // TradeSmart defines no OAuth `state`: any local process or page can deliver a code to the
  // callback, so only keep a token issued to the account the user asked for.
  for (const account of [token.userId, token.accountId]) {
    if (account !== null && account !== "" && account.toLowerCase() !== clientId.toLowerCase()) {
      io.stderr(`This login belongs to account ${account}, not ${clientId} - nothing was saved.`);
      return 1;
    }
  }
  clientId = token.userId ?? token.accountId ?? clientId; // the server's spelling
  try {
    await writeTokenFile(path, { clientId, accessToken: token });
  } catch (error) {
    io.stderr(
      `Logged in, but the token could not be saved to ${path} (${errnoReason(error)}). ` +
        `Choose another file with --token-file PATH and run \`${PROG} login\` again ` +
        "(the login code is single-use).",
    );
    return 1;
  }
  const expires = new Date(token.expiresAt.getTime() + IST_OFFSET_MS)
    .toISOString()
    .slice(0, 16)
    .replace("T", " ");
  io.stdout(`Logged in as ${token.uname ?? clientId} (${token.userId ?? clientId}).`);
  io.stdout(
    `The token is valid until ${expires} IST (TradeSmart tokens expire daily at 06:00 IST).`,
  );
  let logout = `${PROG} logout`;
  let note = "";
  if (path === defaultTokenFilePath(io.env, io.platform, io.home, io.cwd)) {
    io.stdout(`Saved to ${path}; TradeSmart.fromEnv() uses it.`);
  } else {
    io.stdout(
      `Saved to ${path}. For TradeSmart.fromEnv() to use this file, set ${ENV_VAR} in the ` +
        "environment of your scripts:",
    );
    for (const line of envHints(path, io.platform)) io.stdout(`  ${line}`);
    const [arg, powershellOnly] = commandArg(path, io.platform);
    logout += ` --token-file ${arg}`;
    note = powershellOnly ? " (PowerShell)" : "";
  }
  io.stdout(`Remove the saved login with \`${logout}\`${note}.`);
  if (!command.noSaveKeys) await rememberKeys(io, keys, clientId, keysPath, forget);
  return 0;
}
