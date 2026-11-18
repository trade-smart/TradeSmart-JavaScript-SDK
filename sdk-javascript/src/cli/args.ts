// Command-line parsing for `tradesmart [login|token-path|logout]` (sdk-behaviour 6.6), a pure
// function so every rule is unit-tested without running anything.
import { parseArgs } from "node:util";

export const PROG = "npx tradesmart";
export const DEFAULT_PORT = 8080;
export const LOOPBACK = "127.0.0.1";
const COMMANDS = ["login", "token-path", "logout"] as const;

export type Command =
  | {
      command: "login";
      tokenFile: string | undefined;
      clientId: string | undefined;
      appKey: string | undefined;
      port: number;
      noBrowser: boolean;
      listenHost: string;
      noSaveKeys: boolean;
    }
  | { command: "token-path"; tokenFile: string | undefined }
  | {
      command: "logout";
      tokenFile: string | undefined;
      forgetKeys: boolean;
      clientId: string | undefined;
    };

export type ParseResult =
  | { kind: "run"; command: Command }
  | { kind: "help"; text: string }
  | { kind: "usage"; message: string };

export const HELP = `Usage: ${PROG} [login|token-path|logout] [options]

Log in to TradeSmart and save the day's access token for TradeSmart.fromEnv().
Without a command, runs \`login\`.

Commands:
  login        log in in the browser and save the access token (default)
  token-path   print the token file path
  logout       delete the saved token file (and, with --forget-keys, the saved keys)

All commands:
  --token-file PATH   token file to use instead of TRADESMART_TOKEN_FILE or the per-user default

login:
  --client-id ID      your TradeSmart client id (else TRADESMART_CLIENT_ID)
  --app-key KEY       your app's App Key; prefer TRADESMART_APP_KEY or the prompt
                      (command-line arguments are visible to other local users)
  --port PORT         local port of the redirect URL http://${LOOPBACK}:PORT/callback; must
                      match the Redirect URL registered with TradeSmart (default ${String(DEFAULT_PORT)})
  --listen-host IP    IPv4 address the local redirect server binds (default ${LOOPBACK}). In a
                      container use 0.0.0.0 with the port published to the host's loopback only
                      (-p 127.0.0.1:8080:8080); the redirect URL stays
                      http://${LOOPBACK}:PORT/callback
  --no-browser        do not open a browser or listen; print the URL and ask for the code
  --no-save-keys      do not save the App Key and Secret key typed at the prompt (or given with
                      --app-key); keys from environment variables are never saved

logout:
  --forget-keys       also remove the saved App Key and Secret key: of --client-id only, or of
                      every client id when --client-id is not given
  --client-id ID      with --forget-keys: forget only the keys of this client id

The secret key is read from TRADESMART_SECRET_KEY, the saved keys or a prompt without echo.
Exit codes: 0 success, 1 login failed or cancelled, 2 usage or configuration error.`;

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);

class UsageProblem extends Error {}

function port(text: string): number {
  if (!/^\s*\+?\d+\s*$/.test(text)) throw new UsageProblem(`--port: not a port number: '${text}'`);
  const value = Number(text.trim());
  if (value < 1 || value > 65535) {
    throw new UsageProblem(`--port: port must be 1-65535, not ${String(value)}`);
  }
  return value;
}

function ipv4(text: string): string {
  const value = text.trim();
  if (IPV4.test(value)) return value;
  const kind = value.includes(":") ? "an IPv6 address" : "not an IPv4 address";
  throw new UsageProblem(
    `--listen-host: '${text}' is ${kind}; --listen-host accepts IPv4 addresses only`,
  );
}

const TOKEN_FILE = { "token-file": { type: "string" } } as const;
const OPTIONS = {
  login: {
    ...TOKEN_FILE,
    "client-id": { type: "string" },
    "app-key": { type: "string" },
    port: { type: "string" },
    "no-browser": { type: "boolean" },
    "listen-host": { type: "string" },
    "no-save-keys": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  "token-path": { ...TOKEN_FILE, help: { type: "boolean", short: "h" } },
  logout: {
    ...TOKEN_FILE,
    "forget-keys": { type: "boolean" },
    "client-id": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
} as const;

/** Parse `argv` (without the node and script names). */
export function parseCli(argv: readonly string[]): ParseResult {
  const list = [...argv];
  const first = list[0];
  if (first === "-h" || first === "--help") return { kind: "help", text: HELP };
  let name: (typeof COMMANDS)[number] = "login";
  if (first !== undefined && (COMMANDS as readonly string[]).includes(first)) {
    name = first as (typeof COMMANDS)[number];
    list.shift();
  }
  try {
    const { values, positionals } = parseArgs({
      args: list,
      options: OPTIONS[name],
      allowPositionals: true,
      strict: true,
    }) as { values: Record<string, string | boolean | undefined>; positionals: string[] };
    if (values["help"] === true) return { kind: "help", text: HELP };
    if (positionals.length > 0) {
      throw new UsageProblem(`unexpected argument: ${positionals[0] ?? ""}`);
    }
    const str = (key: string): string | undefined => values[key] as string | undefined;
    const tokenFile = str("token-file");
    if (name === "token-path") return { kind: "run", command: { command: name, tokenFile } };
    const clientId = str("client-id");
    if (name === "logout") {
      const forgetKeys = values["forget-keys"] === true;
      if (clientId !== undefined) {
        if (!forgetKeys) {
          throw new UsageProblem(
            "--client-id is used only with --forget-keys (logout always removes the token file)",
          );
        }
        if (clientId.trim() === "") {
          throw new UsageProblem(
            "--client-id must not be blank; leave it out to forget the keys of every client id",
          );
        }
      }
      return { kind: "run", command: { command: name, tokenFile, forgetKeys, clientId } };
    }
    const portText = str("port");
    const hostText = str("listen-host");
    return {
      kind: "run",
      command: {
        command: "login",
        tokenFile,
        clientId,
        appKey: str("app-key"),
        port: portText === undefined ? DEFAULT_PORT : port(portText),
        noBrowser: values["no-browser"] === true,
        listenHost: hostText === undefined ? LOOPBACK : ipv4(hostText),
        noSaveKeys: values["no-save-keys"] === true,
      },
    };
  } catch (error) {
    if (error instanceof UsageProblem) return { kind: "usage", message: error.message };
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string" && code.startsWith("ERR_PARSE_ARGS")) {
      return { kind: "usage", message: (error as Error).message.replace(/\.? To specify.*$/s, "") };
    }
    throw error;
  }
}
