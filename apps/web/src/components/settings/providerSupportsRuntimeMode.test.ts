import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";
import { DRIVER_OPTIONS, getDriverOption } from "./providerDriverMeta";
import { providerSupportsRuntimeMode } from "./providerSupportsRuntimeMode";

describe("provider runtime-mode availability", () => {
  it("offers Pi setup with its own settings schema but not approval modes", () => {
    const pi = ProviderDriverKind.make("pi");
    expect(DRIVER_OPTIONS.some((option) => option.value === pi)).toBe(true);
    expect(getDriverOption(pi)?.settingsSchema.fields).not.toHaveProperty("binaryPath");
    expect(providerSupportsRuntimeMode(pi)).toBe(false);
  });

  it("keeps runtime modes for other built-in and unknown drivers, including custom instances", () => {
    for (const definition of DRIVER_OPTIONS.filter((option) => option.value !== "pi")) {
      expect(providerSupportsRuntimeMode(definition.value)).toBe(true);
    }
    expect(providerSupportsRuntimeMode(ProviderDriverKind.make("forkDriver"))).toBe(true);
    expect(providerSupportsRuntimeMode(undefined)).toBe(true);
  });
});
