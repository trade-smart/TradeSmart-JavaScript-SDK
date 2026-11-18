# The login command

`npx tradesmart` logs you in once a day and saves the day's access token, so that
`TradeSmart.fromEnv()` finds it. It writes the same files as the Python SDK's
`python -m tradesmart login`: the same folder, names and format, so one login serves both SDKs.

```bash
npx tradesmart login        # the default command: plain `npx tradesmart` does the same
npx tradesmart token-path   # print the token file's path
npx tradesmart logout       # delete the saved login
```

Once the package is installed in a project, the command is `tradesmart` (`npx tradesmart` finds it).
You need your Client ID, the App Key and the Secret Key of your API app, and `http://127.0.0.1:8080/callback`
registered as the Redirect URL
([Get API access](getting-started.md#1-get-api-access)).

## What `login` does

1. Asks for what it does not have (Client ID, App Key, Secret Key; the Secret Key is typed without echo).
2. Opens the TradeSmart login page in your browser and waits up to 120 seconds on
   `127.0.0.1:8080` for the redirect to `/callback`. The first valid code wins; it is exchanged once.
3. If no browser can be opened, the port is busy, the wait runs out or you pass `--no-browser`, it prints
   the URL and asks you to paste the code or the whole redirect URL. This is a fallback: run on a machine
   with a browser and the login completes by itself.
4. Checks that the token belongs to the Client ID you asked for (TradeSmart has no OAuth `state`), and
   saves nothing if it does not.
5. Saves the login and prints the name, the Client ID and the expiry (IST). The token is valid until the
   next 06:00 IST.

It never prints the token, the Secret Key, the checksum or the code. Exit codes: `0` success, `1` the login
failed or was cancelled, `2` a usage or configuration error.

## Options

| Option              | Applies to    | What it does                                                                                                     |
| ------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------- |
| `--token-file PATH` | all           | Use this token file instead of `TRADESMART_TOKEN_FILE` or the per-user default                                   |
| `--client-id ID`    | login, logout | Your Client ID (else `TRADESMART_CLIENT_ID`, else a prompt)                                                      |
| `--app-key KEY`     | login         | Your App Key. Prefer `TRADESMART_APP_KEY` or the prompt: command-line arguments are visible to other local users |
| `--port PORT`       | login         | The port of the redirect URL (1 to 65535, default 8080); it must match the registered Redirect URL               |
| `--listen-host IP`  | login         | The IPv4 address the callback server binds (default `127.0.0.1`); see Docker below                               |
| `--no-browser`      | login         | Do not open a browser or listen: print the URL and ask for the code                                              |
| `--no-save-keys`    | login         | Do not save the keys typed at the prompt (or given with `--app-key`)                                             |
| `--forget-keys`     | logout        | Also remove the saved keys: of `--client-id` only, or of every Client ID without it                              |

The Secret Key comes only from `TRADESMART_SECRET_KEY`, the saved keys or the no-echo prompt, never from
an option.

## Saved keys

So that the next login asks only for the browser step, the command saves your App Key and Secret Key
per Client ID.

- **Where:** `credentials.json` beside the token file in use (on Windows `%APPDATA%\tradesmart\`, else
  `~/.config/tradesmart/`, or beside `--token-file`).
- **What is saved:** only keys you typed at the prompt or gave with `--app-key`, and only after the token was
  saved; keys from environment variables are never saved. A failed save only warns.
- **Protection:** created with mode `0600` in a `0700` folder, replaced atomically. **It is not encrypted**:
  whoever can read the file can read the keys. On a shared or retired computer remove them with
  `npx tradesmart logout --forget-keys`.
- **Keys changed on the dashboard?** A login with outdated saved keys fails and the command says the
  saved keys were used and shows the command to forget them; run it and log in again.
- **A damaged or unknown `credentials.json`** stops the login (exit `2`) with a message naming the file,
  never its content, and the file is never overwritten.

| Command                                              | Removes                                               |
| ---------------------------------------------------- | ----------------------------------------------------- |
| `npx tradesmart logout`                              | the saved login only; the saved keys stay             |
| `npx tradesmart logout --forget-keys --client-id ID` | the saved login and that Client ID's saved keys       |
| `npx tradesmart logout --forget-keys`                | the saved login and the saved keys of every Client ID |

## Docker

From a clone of the repository's `sdk-javascript` folder the `login` service runs the command in a
container, with the callback port published to your computer's loopback only:

```bash
docker compose run --rm --service-ports login --client-id YOUR_CLIENT_ID
```

Inside the container the callback server listens on `0.0.0.0` (`--listen-host`) so the published port
reaches it; the Redirect URL stays `http://127.0.0.1:8080/callback`. The service keeps the login in the
`tradesmart-login` volume, shared with the Python SDK's compose project and the other services here. Any non-loopback `--listen-host` prints a warning, and only
an IPv4 address is accepted.

## From code

`TradeSmart.fromEnv()` reads the saved login ([Configuration](configuration.md#environment-variables-and-the-saved-login)). When it
finds none or an expired one, the error tells you to run `npx tradesmart login`. To log in from your own
program, for example a web application, use `loginUrl()` and `generateSession()`
([Getting started](getting-started.md#your-own-login-flow)).
