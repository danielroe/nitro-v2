import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { createError, type H3Event } from "h3";
import type { HTTPProxy } from "./proxy";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "pathe";
import { Worker } from "node:worker_threads";
import consola from "consola";
import { isCI, isTest } from "std-env";
import { createHTTPProxy } from "./proxy";

export type WorkerAddress = { host: string; port: number; socketPath?: string };

export interface WorkerHooks {
  onClose?: (worker: DevWorker, cause?: unknown) => void;
  onReady?: (worker: DevWorker, address?: WorkerAddress) => void;
}

export interface WorkerCloseOptions {
  /**
   * Let requests that are in flight on the worker finish (up to
   * `NITRO_SHUTDOWN_TIMEOUT`) before it is terminated.
   */
  drain?: boolean;
}

export interface DevWorker {
  readonly ready: boolean;
  readonly closed: boolean;
  close(cause?: unknown, opts?: WorkerCloseOptions): Promise<void>;
  handleEvent: (event: H3Event) => Promise<void>;
  handleUpgrade: (
    req: IncomingMessage,
    socket: Socket,
    head: any
  ) => Promise<void> | void;
}

export class NodeDevWorker implements DevWorker {
  closed: boolean = false;
  #id: number;
  #workerDir: string;
  #hooks: WorkerHooks;

  #address?: WorkerAddress;
  #proxy?: HTTPProxy;
  #worker?: Worker & { _exitCode?: number };
  #inflight = new Map<Promise<void>, H3Event>();

  constructor(id: number, workerDir: string, hooks: WorkerHooks = {}) {
    this.#id = id;
    this.#workerDir = workerDir;
    this.#hooks = hooks;
    this.#proxy = createHTTPProxy();
    this.#initWorker();
  }

  get ready() {
    return Boolean(
      !this.closed && this.#address && this.#proxy && this.#worker
    );
  }

  async handleEvent(event: H3Event) {
    if (!this.ready || !this.#address || !this.#proxy) {
      throw createError({
        status: 503,
        statusText: "Dev worker is unavailable",
      });
    }
    const request = this.#proxy.handleEvent(event, { target: this.#address });
    this.#inflight.set(request, event);
    try {
      await request;
    } finally {
      this.#inflight.delete(request);
    }
  }

  handleUpgrade(req: IncomingMessage, socket: Socket, head: any) {
    if (!this.ready) {
      return;
    }
    return this.#proxy!.proxy.ws(
      req,
      socket,
      { target: this.#address, xfwd: true },
      head
    );
  }

  #initWorker() {
    const workerEntryPath = join(this.#workerDir, "index.mjs");

    if (!existsSync(workerEntryPath)) {
      this.close(`worker entry not found in "${workerEntryPath}".`);
      return;
    }

    const worker = new Worker(workerEntryPath, {
      env: {
        ...process.env,
        NITRO_DEV_WORKER_ID: String(this.#id),
      },
    }) as Worker & { _exitCode?: number };

    worker.once("exit", (code) => {
      worker._exitCode = code;
      this.close(`worker exited with code ${code}`);
    });

    worker.once("error", (error) => {
      this.close(error);
    });

    worker.on("message", (message) => {
      if (message?.address) {
        this.#address = message.address;
        this.#hooks.onReady?.(this, this.#address);
      }
    });

    this.#worker = worker;
  }

  async close(cause?: unknown, opts: WorkerCloseOptions = {}) {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.#hooks.onClose?.(this, cause);
    this.#hooks = {};
    const onError = (error: unknown) => consola.error(error);
    if (opts.drain) {
      await this.#drainRequests().catch(onError);
    }
    await this.#closeWorker().catch(onError);
    await this.#closeProxy().catch(onError);
    await this.#closeSocket().catch(onError);
  }

  async #drainRequests() {
    // Event streams never finish on their own, and clients reconnect them to
    // the new worker, so they are not worth waiting for.
    const requests = [...this.#inflight]
      .filter(([, event]) => !isEventStream(event))
      .map(([request]) => request);
    if (requests.length === 0) {
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(requests),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          if (process.env.DEBUG) {
            consola.warn(
              `force closing dev worker with ${this.#inflight.size} request(s) in flight`
            );
          }
          resolve();
        }, getShutdownTimeout());
      }),
    ]);
    clearTimeout(timeout);
  }

  async #closeProxy() {
    this.#proxy?.proxy?.close(() => {
      // TODO: it will be never called! Investigate why and then await on it.
    });
    this.#proxy = undefined;
  }

  async #closeSocket() {
    const socketPath = this.#address?.socketPath;
    if (
      socketPath &&
      socketPath[0] !== "\0" &&
      !socketPath.startsWith(String.raw`\\.\pipe`)
    ) {
      await rm(socketPath).catch(() => {});
    }
    this.#address = undefined;
  }

  async #closeWorker() {
    if (!this.#worker) {
      return;
    }
    this.#worker.postMessage({ event: "shutdown" });

    if (!this.#worker._exitCode && !isTest && !isCI) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (process.env.DEBUG) {
            consola.warn(`force closing dev worker...`);
          }
          resolve();
        }, getShutdownTimeout());

        this.#worker?.on("message", (message) => {
          if (message.event === "exit") {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
    }
    this.#worker.removeAllListeners();
    await this.#worker.terminate().catch((error) => {
      consola.error(error);
    });
    this.#worker = undefined;
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    // eslint-disable-next-line unicorn/no-nested-ternary
    const status = this.closed ? "closed" : this.ready ? "ready" : "pending";
    return `NodeDevWorker#${this.#id}(${status})`;
  }
}

/** Graceful shutdown timeout in milliseconds (`NITRO_SHUTDOWN_TIMEOUT` is in seconds). */
function getShutdownTimeout() {
  const seconds =
    Number.parseInt(process.env.NITRO_SHUTDOWN_TIMEOUT || "", 10) || 5;
  return seconds * 1000;
}

function isEventStream(event: H3Event) {
  const contentType = event.node.res.getHeader("content-type");
  return String(contentType || "").includes("text/event-stream");
}
