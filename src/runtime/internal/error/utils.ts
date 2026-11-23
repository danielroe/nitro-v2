import { type H3Event, getResponseHeader } from "h3";
import type { NitroErrorHandler } from "nitropack/types";

export function defineNitroErrorHandler(
  handler: NitroErrorHandler
): NitroErrorHandler {
  return handler;
}

export type InternalHandlerResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string | Record<string, any>;
};

/**
 * Whether an error response should be sent with `cache-control: no-cache`.
 *
 * A `cache-control` set by the route handler is kept, but not one that was
 * only applied by a `headers` route rule (it is meant for successful responses).
 */
export function shouldDisableErrorCache(
  event: H3Event,
  statusCode: number
): boolean {
  if (statusCode === 404) {
    return true;
  }
  const cacheControl = getResponseHeader(event, "cache-control");
  return (
    !cacheControl ||
    cacheControl === event.context._nitro?.routeRulesCacheControl
  );
}
