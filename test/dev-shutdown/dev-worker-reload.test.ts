import { fileURLToPath } from "node:url";
import { build, createDevServer, createNitro, prepare } from "../../src/core";
import { describe, expect, it } from "vitest";

const rootDir = fileURLToPath(new URL("fixture", import.meta.url));

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startDevServer(name: string) {
  const nitro = await createNitro({
    rootDir,
    dev: true,
    preset: "nitro-dev",
    buildDir: fileURLToPath(new URL(`.nitro/${name}`, import.meta.url)),
    output: {
      dir: fileURLToPath(
        new URL(`.output-worker-reload/${name}`, import.meta.url)
      ),
    },
  });
  const devServer = createDevServer(nitro);
  const server = await devServer.listen(0, { hostname: "127.0.0.1" });
  await prepare(nitro);
  const ready = new Promise<void>((resolve) => {
    nitro.hooks.hook("dev:reload", () => resolve());
  });
  await build(nitro);
  await ready;
  return {
    devServer,
    base: server.url,
    async close() {
      await devServer.close();
      await nitro.close();
    },
  };
}

async function getWorkerState(base: string, path: string) {
  const response = await fetch(base + path);
  expect(response.status).toBe(200);
  return (await response.json()) as { threadId: number; id: string };
}

describe("nitro:dev:worker-reload", () => {
  it("finishes in-flight requests on a worker that is being replaced", async () => {
    const { devServer, base, close } = await startDevServer("reload");
    try {
      const current = await getWorkerState(base, "state");
      const slow = getWorkerState(base, "slow");
      await delay(300);
      devServer.reload();

      const [slowState, nextState] = await Promise.all([
        slow,
        getWorkerState(base, "state"),
      ]);
      expect(slowState).toEqual(current);
      expect(nextState).not.toEqual(current);
    } finally {
      await close();
    }
  }, 30_000);

  it("stops waiting for in-flight requests after the shutdown timeout", async () => {
    const { devServer, base, close } = await startDevServer("timeout");
    process.env.NITRO_SHUTDOWN_TIMEOUT = "1";
    try {
      await getWorkerState(base, "state");
      const hang = fetch(base + "hang");
      await delay(300);
      const reloadedAt = Date.now();
      devServer.reload();

      const response = await hang;
      const elapsed = Date.now() - reloadedAt;
      expect(response.status).toBe(503);
      // Cut by the 1s shutdown timeout, not right away and not by the 5s handler
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(4000);
    } finally {
      delete process.env.NITRO_SHUTDOWN_TIMEOUT;
      await close();
    }
  }, 30_000);

  it("does not keep a replaced worker alive for event streams", async () => {
    const { devServer, base, close } = await startDevServer("stream");
    try {
      const response = await fetch(base + "stream");
      expect(response.status).toBe(200);
      const ended = (async () => {
        const reader = response.body!.getReader();
        try {
          while (!(await reader.read()).done) {
            // Consume events until the stream ends
          }
        } catch {
          // Cut connection
        }
      })();
      await delay(300);
      const reloadedAt = Date.now();
      devServer.reload();

      await ended;
      expect(Date.now() - reloadedAt).toBeLessThan(2000);
    } finally {
      await close();
    }
  }, 30_000);

  it("does not wait for in-flight requests when the dev server closes", async () => {
    const { base, close } = await startDevServer("close");
    await getWorkerState(base, "state");
    const hang = fetch(base + "hang").catch(() => undefined);
    await delay(300);

    const closingAt = Date.now();
    await close();
    expect(Date.now() - closingAt).toBeLessThan(2000);
    await hang;
  }, 30_000);
});
