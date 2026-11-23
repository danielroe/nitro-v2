import { getRequestHeader, getRequestIP, type H3Event } from "h3";

const LOOPBACK_IP_RE = /^(?:::1|127\.\d+\.\d+\.\d+)$/;

/**
 * Whether a request to the dev server is a trusted local request.
 *
 * Used to gate dev-only debug endpoints (the VFS viewer).
 *
 * - The client must connect from the loopback interface, so the endpoints are
 *   not reachable from other hosts when the dev server is bound to a
 *   non-loopback address.
 * - The `Host` header must be a loopback name, so a page using DNS rebinding,
 *   or a remote client going through a tunnel or local reverse proxy (whose
 *   connection also comes from loopback) is rejected.
 * - Cross-site browser requests are rejected, so a page open in the
 *   developer's browser cannot trigger them (CSRF).
 */
export function isLocalDevRequest(event: H3Event): boolean {
  const { socket } = event.node?.req || {};

  // prettier-ignore
  const isUnixSocket =
    // No network addresses
    (!socket?.remoteAddress && !socket?.localAddress) &&
    // Empty address object
    Object.keys(socket?.address?.() || {}).length === 0 &&
    // Socket is readable/writable but has no port info
    socket?.readable && socket?.writable && !socket?.remotePort;

  const ip = getRequestIP(event, { xForwardedFor: isUnixSocket });
  const v4 = ip?.toLowerCase().startsWith("::ffff:") ? ip.slice(7) : ip;
  if (!v4 || !LOOPBACK_IP_RE.test(v4)) {
    return false;
  }

  const host = getRequestHeader(event, "host");
  if (!host || !isLoopbackHost(host)) {
    return false;
  }

  const fetchSite = getRequestHeader(event, "sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return false;
  }

  const origin = getRequestHeader(event, "origin");
  if (origin && !isSameHostOrigin(origin, host)) {
    return false;
  }

  return true;
}

function isLoopbackHost(host: string): boolean {
  const hostname = parseHostname(host);
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    LOOPBACK_IP_RE.test(hostname)
  );
}

function isSameHostOrigin(origin: string, host: string): boolean {
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function parseHostname(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) {
    // IPv6 literal: `[::1]:3000`
    return value.slice(1, value.indexOf("]"));
  }
  return value.replace(/:\d*$/, "").replace(/\.$/, "");
}
