// `runCli`: the whole command line behind one function with injected I/O (so tests drive it
// without a terminal), the JavaScript twin of Python's `main()`. It never prints a token, secret
// key, checksum or auth code. Exit codes: 0 success, 1 failed or cancelled, 2 usage or
// configuration error.
import { PROG, parseCli, type Command } from "./args.js";
import { CliCancelled, errnoReason, type CliIo, type ExitCode } from "./io.js";
import { forgetCommand, login, otherEnvironmentKeys, tokenFileOf } from "./login.js";
import {
  KeyFileError,
  keyFilePath,
  deleteKeyFile,
  forgetKeys,
  savedClientIds,
} from "../token-store/key-file.js";
import { deleteTokenFile } from "../token-store/token-file.js";

type LogoutCommand = Extract<Command, { command: "logout" }>;

/** Delete the token file and say so. */
async function removeLogin(io: CliIo, path: string): Promise<ExitCode> {
  try {
    const removed = await deleteTokenFile(path);
    io.stdout(removed ? `Removed the saved login at ${path}.` : `No saved login at ${path}.`);
    return 0;
  } catch (error) {
    io.stderr(`Could not remove the saved login at ${path} (${errnoReason(error)}).`);
    return 1;
  }
}

/** Remove the saved keys of `clientId`, or the whole file when `undefined`; say which. */
async function forgetSavedKeys(
  io: CliIo,
  keysPath: string,
  clientId: string | undefined,
  forget: string,
): Promise<ExitCode> {
  if (clientId !== undefined) {
    try {
      const forgotten = await forgetKeys(keysPath, clientId);
      io.stdout(
        forgotten
          ? `Forgot the saved keys for ${clientId} in ${keysPath}.`
          : `No saved keys for ${clientId} in ${keysPath}.`,
      );
      return 0;
    } catch (error) {
      if (error instanceof KeyFileError) {
        io.stderr(
          `Cannot forget the keys of ${clientId}: ${error.message}. Run \`${forget}\` ` +
            "(without --client-id) to remove the whole file.",
        );
      } else {
        io.stderr(`Could not update the saved keys at ${keysPath} (${errnoReason(error)}).`);
      }
      return 1;
    }
  }
  let ids: string[] | null;
  try {
    ids = await savedClientIds(keysPath);
  } catch (error) {
    if (!(error instanceof KeyFileError)) throw error;
    ids = null; // unusable: removed below without reading or showing it
  }
  let removed: boolean;
  try {
    removed = await deleteKeyFile(keysPath);
  } catch (error) {
    io.stderr(`Could not remove the saved keys at ${keysPath} (${errnoReason(error)}).`);
    return 1;
  }
  if (!removed) io.stdout(`No saved keys at ${keysPath}.`);
  else if (ids === null) io.stdout(`Removed the unreadable saved keys file ${keysPath}.`);
  else {
    io.stdout(`Forgot the saved keys of every client id (${ids.join(", ")}): removed ${keysPath}.`);
  }
  return 0;
}

async function logout(io: CliIo, command: LogoutCommand): Promise<ExitCode> {
  const path = tokenFileOf(io, command.tokenFile);
  let status = await removeLogin(io, path);
  if (command.forgetKeys) {
    const keysPath = keyFilePath(path);
    const clientId = command.clientId?.trim();
    const problem = clientId === undefined ? null : otherEnvironmentKeys(keysPath);
    if (problem !== null) {
      // Forgetting one id would rewrite that file under this name.
      io.stderr(`Cannot forget the keys of ${clientId ?? ""}: ${problem}`);
      return 1;
    }
    const forgot = await forgetSavedKeys(io, keysPath, clientId, forgetCommand(io, path));
    status = Math.max(status, forgot) as ExitCode;
  }
  return status;
}

/** Run the command line (`argv` without the node and script names); returns the exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<ExitCode> {
  const parsed = parseCli(argv);
  if (parsed.kind === "help") {
    for (const line of parsed.text.split("\n")) io.stdout(line);
    return 0;
  }
  if (parsed.kind === "usage") {
    io.stderr(`${PROG}: error: ${parsed.message}`);
    io.stderr(`Run \`${PROG} --help\` for the options.`);
    return 2;
  }
  const command = parsed.command;
  try {
    switch (command.command) {
      case "login":
        return await login(io, command);
      case "token-path":
        io.stdout(tokenFileOf(io, command.tokenFile));
        return 0;
      case "logout":
        return await logout(io, command);
    }
  } catch (error) {
    if (error instanceof CliCancelled || io.interrupt?.aborted === true) {
      io.stderr("Cancelled.");
      return 1;
    }
    // Only the type and message of an SDK or system error: never a stack, which could carry values.
    io.stderr(`Unexpected error: ${error instanceof Error ? error.name : "error"}`);
    return 1;
  }
}
