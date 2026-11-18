// Opening the login page in the user's browser. The program and its arguments are an array handed
// to `spawn` (never a shell string); only http(s) URLs are opened.
import { spawn } from "node:child_process";

export interface BrowserCommand {
  file: string;
  args: string[];
}

/** Characters cmd.exe would act on inside the argument of `start`. */
const CMD_META = /[&|<>^"]/;

/** The command that opens `url` on `platform`, or `null` when it must not be opened this way. */
export function browserCommand(url: string, platform: NodeJS.Platform): BrowserCommand | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (platform === "win32") {
    return CMD_META.test(url) ? null : { file: "cmd", args: ["/c", "start", "", url] };
  }
  return { file: platform === "darwin" ? "open" : "xdg-open", args: [url] };
}

/** Launch the browser; whether a launcher could be started (not whether the page loaded). */
export function openBrowser(url: string, platform: NodeJS.Platform): Promise<boolean> {
  const command = browserCommand(url, platform);
  if (command === null) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      const child = spawn(command.file, command.args, { stdio: "ignore", detached: true });
      child.once("error", () => {
        resolve(false);
      });
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
