// Line prompts for the login CLI. One reader serves every question, so lines of a piped input
// are never lost between prompts; a hidden answer is read with the terminal output muted.
import readline from "node:readline";
import { Writable } from "node:stream";
import { CliCancelled, type PromptOptions } from "./io.js";

export interface Prompter {
  /** The answer line; `null` when the input has ended. Rejects with `CliCancelled` on Ctrl-C. */
  prompt(question: string, options: PromptOptions): Promise<string | null>;
  close(): void;
}

interface Waiter {
  resolve: (line: string | null) => void;
  reject: (error: Error) => void;
}

export function createPrompter(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Prompter {
  let muted = false;
  const sink = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      if (!muted) output.write(chunk);
      callback();
    },
  });
  const isTTY = (input as { isTTY?: boolean }).isTTY === true;
  let rl: readline.Interface | null = null;
  const lines: string[] = [];
  let waiter: Waiter | null = null;
  let ended = false;

  const start = (): void => {
    if (rl !== null) return;
    const created = readline.createInterface({ input, output: sink, terminal: isTTY });
    created.on("line", (line) => {
      if (waiter === null) {
        lines.push(line);
        return;
      }
      const w = waiter;
      waiter = null;
      w.resolve(line);
    });
    created.on("close", () => {
      ended = true;
      const w = waiter;
      waiter = null;
      w?.resolve(null);
    });
    created.on("SIGINT", () => {
      const w = waiter;
      waiter = null;
      created.close();
      w?.reject(new CliCancelled());
    });
    rl = created;
  };

  return {
    prompt(question, { echo }) {
      start();
      output.write(question);
      const queued = lines.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      if (ended) return Promise.resolve(null);
      muted = !echo && isTTY;
      return new Promise<string | null>((resolve, reject) => {
        waiter = {
          resolve: (line) => {
            if (muted) output.write("\n");
            muted = false;
            resolve(line);
          },
          reject: (error) => {
            muted = false;
            output.write("\n");
            reject(error);
          },
        };
      });
    },
    close() {
      rl?.close();
    },
  };
}
