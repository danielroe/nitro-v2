import { rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { build, createDevServer, createNitro, prepare } from "../../src/core";
import type { DevServerOptions } from "../../src/types";
import { describe, expect, it } from "vitest";

const rootDir = fileURLToPath(new URL("fixture", import.meta.url));

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startDevServer(name: string, drain?: DevServerOptions["drain"]) {
  const nitro = await createNitro({
    rootDir,
    dev: true,
    preset: "nitro-dev",
    devServer: { drain },
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
    nitro,
    devServer,
    base: server.url,
    port: Number(new URL(server.url).port),
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
  it("closes the previous worker on reload by default", async () => {
    const { devServer, base, close } = await startDevServer("default");
    try {
      await getWorkerState(base, "state");
      const slow = fetch(base + "slow");
      await delay(300);
      devServer.reload();

      expect((await slow).status).toBe(503);
    } finally {
      await close();
    }
  }, 30_000);

  it("lets the previous worker finish in-flight requests with `devServer.drain`", async () => {
    const { devServer, base, close } = await startDevServer("drain", true);
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

  it("closes a draining worker after the drain timeout", async () => {
    const { devServer, base, close } = await startDevServer("timeout", {
      timeout: 1000,
    });
    try {
      await getWorkerState(base, "state");
      const hang = fetch(base + "hang");
      await delay(300);
      const reloadedAt = Date.now();
      devServer.reload();

      const response = await hang;
      const elapsed = Date.now() - reloadedAt;
      expect(response.status).toBe(503);
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(4000);
    } finally {
      await close();
    }
  }, 30_000);

  it("keeps a draining worker until its websockets close", async () => {
    const { devServer, base, port, close } = await startDevServer("ws", true);
    try {
      const current = await getWorkerState(base, "state");
      const socket = await openRawWebSocket(port, "/_ws");
      let closed = false;
      socket.once("close", () => (closed = true));
      devServer.reload();

      expect(await getWorkerState(base, "state")).not.toEqual(current);
      await delay(300);
      expect(closed).toBe(false);
      socket.destroy();
    } finally {
      await close();
    }
  }, 30_000);

  it("closes draining workers on build errors", async () => {
    const { nitro, devServer, base, close } = await startDevServer(
      "error",
      true
    );
    try {
      await getWorkerState(base, "state");
      const hang = fetch(base + "hang");
      await delay(300);
      devServer.reload();
      await getWorkerState(base, "state");

      const erroredAt = Date.now();
      await nitro.hooks.callHook("dev:error", new Error("build failed"));
      expect((await hang).status).toBe(503);
      expect(Date.now() - erroredAt).toBeLessThan(2000);
    } finally {
      await close();
    }
  }, 30_000);

  it("reports a failing replacement while the previous worker drains", async () => {
    const { nitro, devServer, base, close } = await startDevServer(
      "crash",
      true
    );
    try {
      await getWorkerState(base, "state");
      const hang = fetch(base + "hang").catch(() => undefined);
      await delay(300);
      await rm(nitro.options.output.serverDir, { recursive: true });
      devServer.reload();

      const requestedAt = Date.now();
      const response = await fetch(base + "state");
      expect(Date.now() - requestedAt).toBeLessThan(2000);
      expect(await response.text()).toContain("worker entry not found");
      await hang;
    } finally {
      await close();
    }
  }, 30_000);

  it("does not wait for draining workers when the dev server closes", async () => {
    const { devServer, base, close } = await startDevServer("close", true);
    await getWorkerState(base, "state");
    const hang = fetch(base + "hang").catch(() => undefined);
    await delay(300);
    devServer.reload();
    await getWorkerState(base, "state");

    const closingAt = Date.now();
    await close();
    expect(Date.now() - closingAt).toBeLessThan(2000);
    await hang;
  }, 30_000);
});

function openRawWebSocket(port: number, path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => {});
    socket.once("connect", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          "Connection: Upgrade\r\nUpgrade: websocket\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
      );
    });
    socket.once("data", (data) => {
      if (String(data).startsWith("HTTP/1.1 101")) {
        resolve(socket);
      } else {
        socket.destroy();
        reject(new Error(`Upgrade failed: ${String(data).split("\r\n")[0]}`));
      }
    });
  });
}
