import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { escribirSumas } from "../lib/sumas.mjs";

test("CHECKSUMS.txt: todos los archivos menos el propio y las firmas, en formato de sha256sum", () => {
  const dir = mkdtempSync(join(tmpdir(), "nexo-sumas-"));
  writeFileSync(join(dir, "b.json"), "{}");
  writeFileSync(join(dir, "a.md"), "hola");
  writeFileSync(join(dir, "a.md.sigstore.json"), "{}");
  writeFileSync(join(dir, "CHECKSUMS.txt"), "viejo");
  assert.deepEqual(escribirSumas(dir), ["a.md", "b.json"]);
  const sha = (t) => createHash("sha256").update(t).digest("hex");
  assert.equal(
    readFileSync(join(dir, "CHECKSUMS.txt"), "utf8"),
    `${sha("hola")}  a.md\n${sha("{}")}  b.json\n`,
  );
});
