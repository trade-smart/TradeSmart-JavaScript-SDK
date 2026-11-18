import { describe, expect, it } from "vitest";
import { browserCommand } from "../../src/cli/browser.js";
import { commandArg, envHints, powershellQuote, quotedArg } from "../../src/cli/login.js";

const URL_OK = "https://auth.example.test/authorize?client_id=abc%2Fdef";

describe("browserCommand", () => {
  it("uses xdg-open, open or cmd start with an argument array", () => {
    expect(browserCommand(URL_OK, "linux")).toEqual({ file: "xdg-open", args: [URL_OK] });
    expect(browserCommand(URL_OK, "darwin")).toEqual({ file: "open", args: [URL_OK] });
    expect(browserCommand(URL_OK, "win32")).toEqual({
      file: "cmd",
      args: ["/c", "start", "", URL_OK],
    });
  });

  it("opens only http and https URLs", () => {
    expect(browserCommand("file:///etc/passwd", "linux")).toBeNull();
    expect(browserCommand("javascript:alert(1)", "linux")).toBeNull();
    expect(browserCommand("not a url", "linux")).toBeNull();
  });

  it("never hands cmd.exe a URL with a shell metacharacter", () => {
    for (const c of ["&", "|", "<", ">", "^", '"']) {
      expect(browserCommand(`https://auth.example.test/a?x=1${c}calc`, "win32")).toBeNull();
    }
    // The same URL is fine where no shell is involved.
    expect(browserCommand("https://auth.example.test/a?x=1&y=2", "linux")).not.toBeNull();
  });
});

describe("shell hints", () => {
  it("POSIX single-quotes the path", () => {
    expect(envHints("/home/u/it's.json", "linux")).toEqual([
      "export TRADESMART_TOKEN_FILE='/home/u/it'\\''s.json'",
    ]);
    expect(commandArg("/a b/t.json", "darwin")).toEqual(["'/a b/t.json'", false]);
  });

  it("Windows gives PowerShell and cmd lines", () => {
    expect(envHints("C:\\Users\\u\\t.json", "win32")).toEqual([
      "PowerShell: $env:TRADESMART_TOKEN_FILE = 'C:\\Users\\u\\t.json'",
      'cmd:        set "TRADESMART_TOKEN_FILE=C:\\Users\\u\\t.json"',
    ]);
    expect(envHints("C:\\100%\\t.json", "win32")[1]).toBe(
      "cmd:        (this path cannot be quoted safely for cmd; use PowerShell)",
    );
  });

  it("Windows command arguments use double quotes unless a shell would expand something", () => {
    expect(commandArg("C:\\Users\\u\\t.json", "win32")).toEqual(['"C:\\Users\\u\\t.json"', false]);
    expect(commandArg("C:\\u$er\\t.json", "win32")).toEqual(["'C:\\u$er\\t.json'", true]);
    expect(commandArg('C:\\u"er\\t.json', "win32")).toEqual(["'C:\\u\"er\\t.json'", true]);
    expect(commandArg("C:\\u\u201Cer\\t.json", "win32")).toEqual(["'C:\\u\u201Cer\\t.json'", true]);
    expect(powershellQuote("a\u2019b")).toBe("'a\u2019\u2019b'");
  });

  it("quotedArg leaves plain ids alone and quotes the rest", () => {
    expect(quotedArg("TEST-123_a.b", "linux")).toBe("TEST-123_a.b");
    expect(quotedArg("a b", "linux")).toBe("'a b'");
    expect(quotedArg("", "linux")).toBe("''");
  });
});
