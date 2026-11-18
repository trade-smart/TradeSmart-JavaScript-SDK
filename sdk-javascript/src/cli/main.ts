#!/usr/bin/env node
// `npx tradesmart [login|token-path|logout]`: only wires the real process into `runCli`.
import os from "node:os";
import process from "node:process";
import { openBrowser } from "./browser.js";
import type { CliIo } from "./io.js";
import { createPrompter } from "./prompt.js";
import { runCli } from "./run.js";

const interrupt = new AbortController();
process.once("SIGINT", () => {
  interrupt.abort();
});

const prompter = createPrompter(process.stdin, process.stdout);
const io: CliIo = {
  env: process.env,
  platform: process.platform,
  home: os.homedir(),
  cwd: process.cwd(),
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  prompt: (question, options) => prompter.prompt(question, options),
  openBrowser: (url) => openBrowser(url, process.platform),
  now: () => new Date(),
  interrupt: interrupt.signal,
};

try {
  process.exitCode = await runCli(process.argv.slice(2), io);
} finally {
  prompter.close();
}
