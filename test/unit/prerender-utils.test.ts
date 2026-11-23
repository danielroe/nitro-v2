import { beforeEach, describe, expect, it } from "vitest";
import type { PrerenderRoute } from "nitropack/types";
import {
  clearLinkParents,
  extractLinks,
  formatPrerenderRoute,
  getLinkParents,
} from "../../src/core/prerender/utils";

describe("prerender utils", () => {
  beforeEach(() => {
    clearLinkParents();
  });

  it("formats linking pages from `linkedFrom`", async () => {
    await extractLinks(
      `<a href="/missing">missing</a>`,
      "/parent",
      new Response(),
      true
    );
    const error = Object.assign(new Error("[404] Not Found"), {
      statusCode: 404,
      statusMessage: "Not Found",
    });
    expect(getLinkParents("/missing")).toEqual(["/parent"]);
    expect(
      formatPrerenderRoute({ route: "/missing", error } as PrerenderRoute)
    ).not.toContain("Linked from");
    expect(
      formatPrerenderRoute({
        route: "/missing",
        error,
        linkedFrom: getLinkParents("/missing"),
      } as PrerenderRoute)
    ).toContain("Linked from /parent");
  });

  it("stores parents by the decoded route", async () => {
    await extractLinks(
      `<a href="/caf%C3%A9">café</a>`,
      "/",
      new Response(),
      true
    );
    expect(getLinkParents("/café")).toEqual(["/"]);
  });

  it("does not throw when a header link cannot be decoded", async () => {
    const res = new Response(null, {
      headers: { "x-nitro-prerender": "/ignored%25" },
    });
    expect(await extractLinks("", "/", res, false)).toEqual(["/ignored%"]);
    expect(getLinkParents("/ignored%")).toEqual([]);
  });
});
