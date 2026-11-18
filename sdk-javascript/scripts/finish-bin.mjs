// After tsc: the bin file must start with the node shebang (tsc keeps the one in the source) and
// be executable where the platform has file modes. npm also sets the mode when it links the bin.
import { chmodSync, readFileSync } from "node:fs";
import { URL } from "node:url";

const bin = new URL("../dist/cli/main.js", import.meta.url);
if (!readFileSync(bin, "utf8").startsWith("#!/usr/bin/env node\n")) {
  throw new Error("dist/cli/main.js does not start with #!/usr/bin/env node");
}
try {
  chmodSync(bin, 0o755);
} catch {
  // A file system without modes (a Windows bind mount): nothing to do.
}
