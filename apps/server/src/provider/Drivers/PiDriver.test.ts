import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { PiSettings } from "@t3tools/contracts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const decodeLegacyPiSettings = Schema.decodeUnknownSync(PiSettings);

describe("Pi built-in driver", () => {
  it("registers Pi with SDK-only settings", () => {
    expect(BUILT_IN_DRIVERS.some((driver) => driver.driverKind === "pi")).toBe(true);
    expect(decodePiSettings({})).toMatchObject({
      enabled: true,
      customModels: [],
    });
    expect(PiSettings.fields).not.toHaveProperty("binaryPath");
    expect(decodeLegacyPiSettings({ binaryPath: "/old/pi", enabled: true })).toEqual({
      enabled: true,
      customModels: [],
    });
  });
});
