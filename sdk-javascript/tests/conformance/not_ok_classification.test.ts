import { describe, it } from "vitest";
import { loadVector } from "./vectors.js";
import { runClassifyCase } from "./classify-case.js";

describe("not_ok_classification.json", () => {
  const vector = loadVector("not_ok_classification.json");
  for (const c of vector.cases) {
    it(c.name, () => {
      runClassifyCase(c, false);
    });
  }
});
