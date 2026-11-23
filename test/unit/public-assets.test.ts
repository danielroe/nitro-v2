import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "pathe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Nitro } from "nitropack/types";
import { publicAssets } from "../../src/rollup/plugins/public-assets";

const ASSETS: Record<string, { path: string }> = {
  "/index.html": { path: "../public/index.html" },
};

// Return the `node` reader source, asserting `serveStatic: true` (used by all
// node-based presets) routes to it.
function nodeReaderTemplate(): string {
  const vfs: Record<string, any> = {};
  publicAssets({
    options: { serveStatic: true, publicAssets: [] },
    vfs,
  } as unknown as Nitro);
  expect(vfs["#nitro-internal-virtual/public-assets"]()).toContain(
    `from "#nitro-internal-virtual/public-assets-node"`
  );
  return vfs["#nitro-internal-virtual/public-assets-node"]();
}

// Evaluate the generated `readAsset` template with a stubbed `fs`.
function loadReadAsset(readFile: () => Promise<unknown>) {
  const fsp = { readFile };
  // Strip the (single-line) imports and bridge their bindings in as args instead.
  const body = nodeReaderTemplate()
    .replace(/^\s*import\s.*$/gm, "")
    .replace(/export\s+function/, "function")
    .replaceAll("import.meta.url", "__serverMain");
  return new Function(
    "fsp",
    "fileURLToPath",
    "resolve",
    "dirname",
    "assets",
    "__serverMain",
    `${body}\nreturn readAsset;`
  )(
    fsp,
    fileURLToPath,
    resolve,
    dirname,
    ASSETS,
    // Absolute on every platform (resolves to the current drive on Windows)
    pathToFileURL("/app/server/index.mjs").href
  ) as (id: string) => Promise<unknown>;
}

describe("virtual/public-assets node reader", () => {
  // A public dir pruned after the build (uploaded to a CDN, sourcemaps stripped)
  // leaves manifest entries with no file behind them; those read as absent so the
  // static middleware can answer 404 rather than surfacing an unhandled 500.
  it("resolves with no data when the file is gone", async () => {
    const readAsset = loadReadAsset(() =>
      Promise.reject(
        Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })
      )
    );

    await expect(readAsset("/index.html")).resolves.toBeUndefined();
  });

  it("rejects for read errors other than a missing file", async () => {
    const readAsset = loadReadAsset(() =>
      Promise.reject(
        Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        })
      )
    );

    await expect(readAsset("/index.html")).rejects.toThrow("EACCES");
  });
});

describe("virtual/public-assets-data", () => {
  let dir: string;

  beforeAll(async () => {
    // The `nitro-dev` preset uses the same dir for server output and public
    // output, so it holds the previous dev build on rebuilds.
    dir = await mkdtemp(join(tmpdir(), "nitro-public-assets-"));
    await writeFile(join(dir, "index.mjs"), `const secret = "s3cret";`);
    await writeFile(join(dir, "index.mjs.map"), "{}");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function manifest(dev: boolean) {
    const vfs: Record<string, any> = {};
    publicAssets({
      options: {
        dev,
        serveStatic: true,
        publicAssets: [],
        output: { publicDir: dir, serverDir: dir },
      },
      vfs,
    } as unknown as Nitro);
    const code: string =
      await vfs["#nitro-internal-virtual/public-assets-data"]();
    return JSON.parse(code.replace(/^export default /, "").replace(/;$/, ""));
  }

  it("does not expose the dev server build as public assets", async () => {
    expect(await manifest(true)).toEqual({});
  });

  it("lists files of the public output dir in production", async () => {
    expect(Object.keys(await manifest(false)).sort()).toEqual([
      "/index.mjs",
      "/index.mjs.map",
    ]);
  });
});
