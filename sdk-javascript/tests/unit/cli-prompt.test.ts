import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CliCancelled } from "../../src/cli/io.js";
import { createPrompter } from "../../src/cli/prompt.js";

function setup(isTTY = false) {
  const input = new PassThrough();
  const output = new PassThrough();
  Object.assign(input, { isTTY });
  let written = "";
  output.on("data", (chunk: Buffer) => (written += chunk.toString()));
  const prompter = createPrompter(input, output);
  return { input, prompter, written: () => written };
}

describe("prompter", () => {
  it("reads successive lines of a piped input with one reader", async () => {
    const { input, prompter } = setup();
    input.write("first\nsecond\n");
    expect(await prompter.prompt("One: ", { echo: true })).toBe("first");
    expect(await prompter.prompt("Two: ", { echo: false })).toBe("second");
    prompter.close();
  });

  it("returns null at the end of the input", async () => {
    const { input, prompter } = setup();
    input.end();
    expect(await prompter.prompt("One: ", { echo: true })).toBeNull();
    expect(await prompter.prompt("Two: ", { echo: true })).toBeNull();
    prompter.close();
  });

  it("writes the question, and on a terminal never echoes a hidden answer", async () => {
    const { input, prompter, written } = setup(true);
    const pending = prompter.prompt("Secret key: ", { echo: false });
    input.write("synthetic-secret\n");
    expect(await pending).toBe("synthetic-secret");
    expect(written()).toContain("Secret key: ");
    expect(written()).not.toContain("synthetic-secret");
    prompter.close();
  });

  it("echoes a visible answer on a terminal", async () => {
    const { input, prompter, written } = setup(true);
    const pending = prompter.prompt("Client id: ", { echo: true });
    input.write("TEST123\n");
    expect(await pending).toBe("TEST123");
    expect(written()).toContain("TEST123");
    prompter.close();
  });

  it("a prompt left open when the prompter closes ends as null", async () => {
    const { prompter } = setup();
    const pending = prompter.prompt("One: ", { echo: true });
    prompter.close();
    expect(await pending).toBeNull();
  });

  it("Ctrl-C on a terminal rejects with CliCancelled", async () => {
    const { input, prompter } = setup(true);
    const pending = prompter.prompt("One: ", { echo: true });
    input.write("\u0003");
    await expect(pending).rejects.toBeInstanceOf(CliCancelled);
    prompter.close();
  });
});
