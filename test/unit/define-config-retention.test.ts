import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { loadOptions } from "../../src/core/config/loader";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("config: defineNitroConfig retention", () => {
  it("does not retain the first call's config overrides", async () => {
    let marker: (() => void) | undefined = () => {};
    const ref = new WeakRef(marker);

    await loadOptions({ marker } as unknown as Parameters<
      typeof loadOptions
    >[0]);
    await loadOptions({});
    marker = undefined;

    for (let i = 0; i < 10; i++) {
      gc();
      await settle();
    }

    expect(ref.deref()).toBeUndefined();
  });
});
