import { describe, expect, it } from "bun:test";

import { cliExternalizePluginCreate } from "./cliExternalizePluginCreate.ts";

describe("cliExternalizePluginCreate", () => {
  it("leaves native runtime packages external and bundles ordinary dependencies", () => {
    let resolve: ((args: { path: string }) => unknown) | undefined;
    cliExternalizePluginCreate().setup({
      onResolve(_options, callback) {
        resolve = callback;
      },
    } as unknown as Bun.PluginBuilder);

    expect(resolve?.({ path: "node-pty" })).toEqual({ path: "node-pty", external: true });
    expect(resolve?.({ path: "@yuuang/ffi-rs-linux-x64-gnu" })).toEqual({
      path: "@yuuang/ffi-rs-linux-x64-gnu",
      external: true,
    });
    expect(resolve?.({ path: "effect/Effect" })).toBeUndefined();
  });
});
