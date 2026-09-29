import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

const decodeSettings = Schema.decodeSync(ServerSettings);

describe("provider instance registry hydration", () => {
  it("hydrates a settings-backed Pi default without enabling unrelated optional providers", () => {
    const settings = decodeSettings({
      providerInstances: { pi: { driver: "pi", enabled: true, config: {} } },
    });
    const instances = deriveProviderInstanceConfigMap(settings);

    expect(instances[ProviderInstanceId.make("pi")]).toEqual({
      driver: "pi",
      enabled: true,
      config: {},
    });
    expect(instances[ProviderInstanceId.make("cursor")]).toMatchObject({
      driver: "cursor",
      config: { enabled: false },
    });
    expect(instances[ProviderInstanceId.make("grok")]).toMatchObject({
      driver: "grok",
      config: { enabled: false },
    });
    expect(instances[ProviderInstanceId.make("opencode")]).toMatchObject({
      driver: "opencode",
      config: { enabled: false },
    });
  });

  it("preserves an explicitly disabled Pi default instance", () => {
    const settings = decodeSettings({
      providerInstances: {
        pi: { driver: "pi", enabled: false, config: { enabled: false } },
      },
    });

    expect(deriveProviderInstanceConfigMap(settings)[ProviderInstanceId.make("pi")]).toEqual({
      driver: "pi",
      enabled: false,
      config: { enabled: false },
    });
  });

  it("does not add an enabled default beside an explicitly configured Pi instance", () => {
    const configuredPi = { driver: "pi", enabled: false, config: { customModels: [] } } as const;
    const settings = decodeSettings({
      providerInstances: { pi_custom: configuredPi },
    });

    const instances = deriveProviderInstanceConfigMap(settings);
    expect(instances[ProviderInstanceId.make("pi_custom")]).toEqual(configuredPi);
    expect(instances).not.toHaveProperty("pi");
    expect(instances[ProviderInstanceId.make("codex")]).toMatchObject({ driver: "codex" });
  });

  it("remains idempotent when the hydrated map is hydrated again", () => {
    const settings = decodeSettings({
      providerInstances: { pi: { driver: "pi", enabled: true, config: {} } },
    });
    const first = deriveProviderInstanceConfigMap(settings);
    const second = deriveProviderInstanceConfigMap({ ...settings, providerInstances: first });

    expect(second).toEqual(first);
  });
});
