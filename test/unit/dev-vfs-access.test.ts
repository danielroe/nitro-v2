import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { toNodeListener } from "h3";
import { createHooks } from "hookable";
import type { Nitro, NitroDevServer } from "nitropack/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDevServer } from "../../src/core/dev-server/server";

const VFS_PATH = "/_vfs.json/%23internal%2Fsecret";

function fetchVFS(port: number, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        port,
        host: "127.0.0.1",
        path: VFS_PATH,
        headers: { host: `localhost:${port}`, ...headers },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      }
    );
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error("no response"));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("dev server: /_vfs access", () => {
  let nitroDevServer: NitroDevServer;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const nitro = {
      hooks: createHooks(),
      vfs: { "#internal/secret": "export default 'storage-password'" },
      options: {
        output: { dir: "/tmp/nitro-dev-vfs", serverDir: "server" },
        buildDir: "/tmp/nitro-dev-vfs/.nitro",
        devServer: { watch: [] },
        devHandlers: [],
        publicAssets: [],
        routeRules: {},
        runtimeConfig: { app: { baseURL: "/" } },
        devProxy: {},
        virtual: {},
      },
    } as unknown as Nitro;
    nitroDevServer = createDevServer(nitro);
    server = createServer(toNodeListener(nitroDevServer.app));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve())
    );
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await nitroDevServer.close();
    await new Promise((resolve) => server.close(resolve));
  });

  it("allows same-origin local requests", async () => {
    const res = await fetchVFS(port);
    expect(res.status).toBe(200);
    expect(res.body).toContain("storage-password");

    for (const headers of <Record<string, string>[]>[
      {
        host: `127.0.0.1:${port}`,
        "sec-fetch-site": "same-origin",
        origin: `http://127.0.0.1:${port}`,
      },
      { host: `[::1]:${port}`, "sec-fetch-site": "none" },
      { host: `app.localhost:${port}` },
    ]) {
      expect((await fetchVFS(port, headers)).status, headers.host).toBe(200);
    }
  });

  // DNS rebinding, tunnels and local reverse proxies all connect from loopback
  it("rejects a non-loopback Host", async () => {
    for (const host of [
      `evil.example:${port}`,
      "abc.trycloudflare.com",
      `localhost.evil.example:${port}`,
    ]) {
      const res = await fetchVFS(port, { host });
      expect(res.status, host).toBe(403);
      expect(res.body).not.toContain("storage-password");
    }
  });

  it("rejects cross-site browser requests", async () => {
    for (const headers of <Record<string, string>[]>[
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { origin: "http://evil.example" },
    ]) {
      expect((await fetchVFS(port, headers)).status).toBe(403);
    }
  });
});
