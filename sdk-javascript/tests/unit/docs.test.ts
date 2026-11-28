// The documentation is part of the product, so it is tested: every fenced `ts` block of README.md
// and docs/*.md and every file in examples/ type-checks against the SDK's own source (the
// `tradesmart` import resolves to src/index.ts through the tsconfig `paths`), the npm README has
// no relative link and states the behaviour level, the public text names no internal material and
// no other broker, and the CommonJS example runs under Node from the built `dist/`.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const REPO = path.resolve(ROOT, "..");

const DOC_FILES = [
  "README.md",
  "analytics.md",
  "architecture.md",
  "configuration.md",
  "errors.md",
  "getting-started.md",
  "greeks.md",
  "instruments.md",
  "login.md",
  "logging.md",
  "orders.md",
  "reference.md",
  "stream.md",
  "testing.md",
].map((name) => `docs/${name}`);

const EXAMPLE_FILES = [
  "login-and-profile.ts",
  "read-account.ts",
  "quote-and-history.ts",
  "place-and-cancel-test-account.ts",
  "stream-touchline.ts",
  "sliced-order.ts",
  "gtt.ts",
  "oco-exit.ts",
  "greeks.ts",
  "analytics.ts",
  "offline-broker-test.ts",
  "commonjs-require.cjs",
].map((name) => `examples/${name}`);

const PACKAGE_DOC_FILES = ["README.md", ...DOC_FILES];
const PUBLIC_TEXT_FILES = [
  ...PACKAGE_DOC_FILES,
  ...EXAMPLE_FILES,
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "repo-root/README.md",
  "repo-root/CONTRIBUTING.md",
  "repo-root/SECURITY.md",
  "repo-root/CODE_OF_CONDUCT.md",
  "repo-root/.github/PULL_REQUEST_TEMPLATE.md",
  "repo-root/.github/ISSUE_TEMPLATE/bug_report.yml",
  "repo-root/.github/ISSUE_TEMPLATE/config.yml",
  "repo-root/.github/ISSUE_TEMPLATE/feature_request.yml",
];

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

/** The first Markdown heading line (a logo block may come before it). */
function firstHeading(text: string): string | undefined {
  return text.split("\n").find((line) => line.startsWith("# "));
}

/** The fenced code blocks tagged exactly `ts`, with the line of the opening fence. */
function tsBlocks(text: string): { line: number; code: string }[] {
  const blocks: { line: number; code: string }[] = [];
  const lines = text.split("\n");
  let open: { line: number; body: string[] } | null = null;
  lines.forEach((raw, index) => {
    const line = raw.trimEnd();
    if (open === null) {
      if (/^```ts$/.test(line)) open = { line: index + 1, body: [] };
      return;
    }
    if (/^```$/.test(line)) {
      blocks.push({ line: open.line, code: open.body.join("\n") });
      open = null;
    } else {
      open.body.push(raw);
    }
  });
  return blocks;
}

describe("documentation files", () => {
  it("exist", () => {
    const missing = [...PUBLIC_TEXT_FILES].filter((rel) => !existsSync(path.join(ROOT, rel)));
    expect(missing).toEqual([]);
  });

  it("README.md and the guide carry at least one typed code sample each", () => {
    for (const rel of [
      "README.md",
      "docs/getting-started.md",
      "docs/orders.md",
      "docs/stream.md",
    ]) {
      expect(tsBlocks(read(rel)).length, rel).toBeGreaterThan(0);
    }
  });
});

describe("type-checking", () => {
  it("every ts block and every example type-checks", () => {
    const config = ts.readConfigFile(path.join(ROOT, "tsconfig.json"), (file) =>
      ts.sys.readFile(file),
    );
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
    const options: ts.CompilerOptions = { ...parsed.options, noEmit: true };

    const virtual = new Map<string, string>();
    const snippetDir = path.join(ROOT, "tests", ".docs-snippets").replaceAll("\\", "/");
    for (const rel of PACKAGE_DOC_FILES) {
      for (const block of tsBlocks(read(rel))) {
        const name = `${rel.replaceAll("/", "__")}__L${String(block.line)}.ts`;
        // `export {}` makes every snippet a module of its own (top-level `const client` repeats).
        virtual.set(`${snippetDir}/${name}`, `${block.code}\nexport {};\n`);
      }
    }
    const examples = EXAMPLE_FILES.filter((rel) => rel.endsWith(".ts")).map((rel) =>
      path.join(ROOT, rel).replaceAll("\\", "/"),
    );

    const host = ts.createCompilerHost(options);
    const realFileExists = host.fileExists.bind(host);
    const realReadFile = host.readFile.bind(host);
    const realGetSourceFile = host.getSourceFile.bind(host);
    host.fileExists = (file) => virtual.has(file) || realFileExists(file);
    host.readFile = (file) => virtual.get(file) ?? realReadFile(file);
    host.getSourceFile = (file, languageVersion, ...rest) => {
      const text = virtual.get(file);
      return text === undefined
        ? realGetSourceFile(file, languageVersion, ...rest)
        : ts.createSourceFile(file, text, languageVersion);
    };

    const roots = [...virtual.keys(), ...examples];
    const program = ts.createProgram({ rootNames: roots, options, host });
    const ours = new Set(roots);
    const problems = ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file === undefined || ours.has(d.file.fileName))
      .map((d) => {
        const text = ts.flattenDiagnosticMessageText(d.messageText, "\n");
        if (d.file === undefined || d.start === undefined) return text;
        const { line } = d.file.getLineAndCharacterOfPosition(d.start);
        return `${path.basename(d.file.fileName)}:${String(line + 1)} ${text}`;
      });
    expect(problems).toEqual([]);
    expect(roots.length).toBeGreaterThan(EXAMPLE_FILES.length);
  }, 180_000);
});

describe("the npm README", () => {
  const readme = (): string => read("README.md");

  it("is titled for JavaScript and TypeScript and states the behaviour level", () => {
    expect(firstHeading(readme())).toBe("# TradeSmart SDK for JavaScript and TypeScript");
    expect(readme()).toContain("TradeSmart SDK behaviour 2.0 — full");
    expect(read("CHANGELOG.md")).toContain("TradeSmart SDK behaviour 2.0 — full");
  });

  it("has no relative link (npm renders it away from the repository)", () => {
    const text = readme();
    const targets = [...text.matchAll(/\]\(([^)\s]+)/g)].map((m) => m[1] ?? "");
    targets.push(...[...text.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1] ?? ""));
    const relative = targets.filter((t) => !t.startsWith("https://") && !t.startsWith("mailto:"));
    expect(relative).toEqual([]);
    expect(targets.length).toBeGreaterThan(5);
  });

  it("links only to files that exist in the repository", () => {
    const prefix =
      /^https:\/\/github\.com\/trade-smart\/TradeSmart-JavaScript-SDK\/(?:blob|tree)\/main\//;
    const links = [...readme().matchAll(/\]\((https:\/\/[^)\s]+)/g)].map((m) => m[1] ?? "");
    const repoLinks = links.filter((l) => prefix.test(l));
    expect(repoLinks.length).toBeGreaterThan(5);
    const missing = repoLinks
      .map((l) => l.replace(prefix, "").replace(/#.*$/, ""))
      .filter((rel) => !existsSync(path.join(REPO, rel)));
    expect(missing).toEqual([]);
  });

  it("the other index pages are titled for JavaScript and TypeScript too", () => {
    for (const rel of ["repo-root/README.md", "docs/README.md"]) {
      expect(firstHeading(read(rel)), rel).toContain("JavaScript and TypeScript");
    }
  });

  it("both READMEs open with the logo, from the newest released tag, light and dark", () => {
    // The tag must exist on GitHub: the newest CHANGELOG version with a date, not "Unreleased"
    // (an exported but unreleased version would otherwise show a broken logo).
    const released = /^## \[(\d+\.\d+\.\d+)\] — \d{4}-\d{2}-\d{2}$/m.exec(read("CHANGELOG.md"));
    expect(released, "a released version in CHANGELOG.md").not.toBeNull();
    const version = released?.[1] ?? "";
    const cdn = `https://cdn.jsdelivr.net/gh/trade-smart/TradeSmart-JavaScript-SDK@v${version}/`;
    for (const rel of ["README.md", "repo-root/README.md"]) {
      const text = read(rel);
      const head = text.slice(0, text.indexOf("\n# "));
      const images = [...head.matchAll(/(?:src|srcset)="([^"]+)"/g)].map((m) => m[1] ?? "");
      expect(images, rel).toHaveLength(2);
      for (const url of images) {
        expect(url.startsWith(cdn), url).toBe(true);
        expect(existsSync(path.join(REPO, url.slice(cdn.length))), url).toBe(true);
      }
      expect(head, rel).toContain('alt="TradeSmart"');
      expect(head, rel).toContain('media="(prefers-color-scheme: dark)"');
    }
  });
});

describe("released text", () => {
  it("no shipped page says the package is not on npm", () => {
    const pages = ["README.md", "repo-root/README.md", "CHANGELOG.md"];
    pages.push(
      ...readdirSync(path.join(ROOT, "docs"))
        .filter((n) => n.endsWith(".md"))
        .map((n) => `docs/${n}`),
    );
    const stale = pages.filter((rel) => /not (?:yet )?on npm|not on npm yet/i.test(read(rel)));
    expect(stale).toEqual([]);
  });
});

describe("public text", () => {
  // Patterns are spelled in pieces so that this file does not contain them itself.
  const forbidden = new RegExp(
    [
      "inter" + "nal/",
      "(?<![\\w-])inter" + "nal(?=[)\\]`\"'>])",
      "plot" + "\\.md",
      "Master" + "_Prompt",
      "CLAUDE" + "\\.md",
      "\\.clau" + "de/",
      "\\.super" + "powers",
      "docs/super" + "powers",
    ].join("|"),
    "i",
  );
  const brokers = new RegExp(
    `\\b(${["zero" + "dha", "ki" + "te", "dh" + "an", "dh" + "anhq", "up" + "stox"].join("|")})\\b`,
    "i",
  );
  const processId = /\bruling\s+[A-Z]\d+\b/i;
  const openItem = /\bF\d{1,3}\b/;

  it("names no internal material, no review-ruling id and no open-item id", () => {
    const bad = PUBLIC_TEXT_FILES.filter((rel) => {
      const text = read(rel);
      return forbidden.test(text) || processId.test(text) || openItem.test(text);
    });
    expect(bad).toEqual([]);
  });

  it("names no other broker", () => {
    expect(PUBLIC_TEXT_FILES.filter((rel) => brokers.test(read(rel)))).toEqual([]);
  });

  it("holds no token-shaped or credential-shaped literal", () => {
    // A long unbroken run of letters and digits would be a pasted token or key.
    // (letters and digits mixed, so heading anchors and long words are not flagged)
    const token = /\b(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{32,}\b/;
    const bad = PUBLIC_TEXT_FILES.filter((rel) => token.test(read(rel)));
    expect(bad).toEqual([]);
  });
});

describe("examples", () => {
  it("the order examples are marked for a test account and never use a market order", () => {
    for (const rel of ["examples/place-and-cancel-test-account.ts", "examples/sliced-order.ts"]) {
      const text = read(rel);
      expect(text, rel).toMatch(/test account/i);
      expect(text, rel).not.toMatch(/OrderType\.MARKET|["']MKT["']/);
    }
  });
});

describe("commonjs-require.cjs", () => {
  beforeAll(() => {
    // The example loads the package from `dist/`; build it so the run is never stale.
    execFileSync(
      process.execPath,
      [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"],
      { cwd: ROOT, stdio: "pipe" },
    );
  }, 180_000);

  it("loads TradeSmart with require('tradesmart') from the built package", () => {
    const version = (JSON.parse(read("package.json")) as { version: string }).version;
    // Node resolves the package's own name through its `exports` (self-reference), and
    // `require()` loads the ES module build (Node 22.19 and later).
    const out = execFileSync(process.execPath, ["examples/commonjs-require.cjs"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out.trim()).toBe(`tradesmart ${version} TradeSmart function`);
  }, 60_000); // spawns a child Node process; the default 5 s limit timed out under coverage load

  it("uses require('tradesmart')", () => {
    expect(read("examples/commonjs-require.cjs")).toContain('require("tradesmart")');
  });

  it("the package declares the self-referencing export the example relies on", () => {
    const pkg = JSON.parse(read("package.json")) as { name: string; exports: object };
    expect(pkg.name).toBe("tradesmart");
    expect(pkg.exports).toHaveProperty(".");
  });
});

describe("login hint", () => {
  it("names both login commands and the package ships the tradesmart bin", async () => {
    const pkg = JSON.parse(read("package.json")) as { bin?: Record<string, string> };
    const { LOGIN_HINT } = await import("../../src/auth.js");
    expect(LOGIN_HINT).toContain("`npx tradesmart login`");
    expect(LOGIN_HINT).toContain("`python -m tradesmart login`");
    expect(LOGIN_HINT).not.toMatch(/not released/i);
    expect(pkg.bin).toEqual({ tradesmart: "./dist/cli/main.js" });
  });

  it("the CLI entry starts with the node shebang", () => {
    expect(read("src/cli/main.ts").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });
});

describe("abort after hand-over on a write (design §7.8)", () => {
  const read = (f: string): string => readFileSync(path.join(ROOT, "docs", f), "utf8");

  it("orders.md does not list an abort among the causes of OrderStatusUnknownError", () => {
    const text = read("orders.md").replace(/\s+/g, " ");
    const m = /\(([^)]*)\) the call rejects with \*\*`OrderStatusUnknownError`\*\*/.exec(text);
    expect(m).not.toBeNull();
    expect(m?.[1]).not.toMatch(/abort/i);
    expect(text).toMatch(/abort after the request was handed over[^.]*signal's own reason/i);
  });

  it("errors.md does not list an abort among the causes of OrderStatusUnknownError", () => {
    const text = read("errors.md").replace(/\s+/g, " ");
    const start = text.indexOf("A state-changing call rejects with `OrderStatusUnknownError`");
    expect(start).toBeGreaterThanOrEqual(0);
    const list = text.slice(start, text.indexOf(" An abort after", start));
    expect(list).not.toMatch(/abort/i);
    expect(text).toMatch(/An abort after the request was handed over is not an SDK error/);
  });
});

describe("docs directory", () => {
  it("holds only the planned pages", () => {
    const found = readdirSync(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md"));
    expect(found.sort()).toEqual(DOC_FILES.map((f) => path.basename(f)).sort());
  });
});

describe("phase-2 pages", () => {
  it("the guide's index and the npm README link every new page", () => {
    for (const page of ["greeks.md", "analytics.md", "login.md"]) {
      expect(read("docs/README.md"), page).toContain(`(${page})`);
      expect(read("README.md"), page).toContain(`/sdk-javascript/docs/${page})`);
    }
  });

  it("nothing still says a recommended part is not in this release", () => {
    for (const rel of PUBLIC_TEXT_FILES) {
      expect(read(rel), rel).not.toMatch(/later release|not in this release|is not released yet/i);
    }
  });

  it("testing.md and the changelog state the ESM-only, one-port facts", () => {
    expect(read("docs/testing.md")).toMatch(/ESM-only/);
    expect(read("CHANGELOG.md")).toMatch(/ESM-only/);
  });
});

describe("package metadata and the Node floor", () => {
  const pkg = JSON.parse(read("package.json")) as { engines: { node: string } };

  it("declares the Node floor undici 8 needs (22.19), not the older 22.12", () => {
    expect(pkg.engines.node).toBe(">=22.19");
  });

  it("no current document or example states the 22.12 floor", () => {
    // CHANGELOG.md is excluded: its dated entries record what each release declared.
    const files = [
      "README.md",
      "repo-root/README.md",
      "repo-root/.github/ISSUE_TEMPLATE/bug_report.yml",
      "examples/commonjs-require.cjs",
      ...DOC_FILES,
    ];
    for (const file of files) {
      expect(read(file), file).not.toContain("22.12");
    }
  });
});
