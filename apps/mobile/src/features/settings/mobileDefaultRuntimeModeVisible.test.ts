import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { mobileDefaultRuntimeModeVisible } from "./mobileDefaultRuntimeModeVisible";
import { resolveMobileSettingsTargets } from "./settings-scoped-server";
import type { SettingsTarget } from "./settings-environment-filter";

function target(defaultDriver: string, projectDriver?: string): SettingsTarget {
  const providers = ["pi", "codex"].map((driver) => ({
    instanceId: ProviderInstanceId.make(driver),
    driver,
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    models: [
      {
        slug: `${driver}-model`,
        name: driver,
        isDefault: driver === defaultDriver,
        capabilities: null,
      },
    ],
  }));
  return {
    environmentId: "environment",
    serverConfig: {
      providers,
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [ProviderInstanceId.make("pi")]: { driver: "pi", enabled: true },
          [ProviderInstanceId.make("codex")]: { driver: "codex", enabled: true },
        },
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make(defaultDriver),
          model: `${defaultDriver}-model`,
        },
        projectSettingsOverrides: projectDriver
          ? {
              project: {
                defaultModelSelection: {
                  instanceId: ProviderInstanceId.make(projectDriver),
                  model: `${projectDriver}-model`,
                },
              },
            }
          : {},
      },
      environment: { capabilities: { projectSettingsOverrides: true } },
    } as unknown as ServerConfig,
  } as SettingsTarget;
}

describe("mobile default permissions visibility", () => {
  it("uses each scoped effective model, retaining the control for mixed providers", () => {
    const pi = target("pi");
    const codex = target("codex");
    const environmentTargets = (entries: SettingsTarget[]) =>
      resolveMobileSettingsTargets(entries, null);
    expect(mobileDefaultRuntimeModeVisible(environmentTargets([pi]))).toBe(false);
    expect(mobileDefaultRuntimeModeVisible(environmentTargets([pi, codex]))).toBe(true);
    expect(mobileDefaultRuntimeModeVisible(environmentTargets([codex]))).toBe(true);
    expect(
      mobileDefaultRuntimeModeVisible(
        resolveMobileSettingsTargets(
          [target("codex", "pi")],
          [
            {
              environmentId: "environment" as SettingsTarget["environmentId"],
              id: "project" as NonNullable<
                Parameters<typeof resolveMobileSettingsTargets>[1]
              >[number]["id"],
            },
          ],
        ),
      ),
    ).toBe(false);
  });

  it("uses the available provider default without a stored model, and keeps unknown providers visible", () => {
    const pi = target("pi");
    const withoutSelection = {
      ...pi,
      serverConfig: {
        ...pi.serverConfig,
        settings: { ...pi.serverConfig.settings, defaultModelSelection: null },
      },
    };
    expect(
      mobileDefaultRuntimeModeVisible(resolveMobileSettingsTargets([withoutSelection], null)),
    ).toBe(false);
    expect(mobileDefaultRuntimeModeVisible([])).toBe(true);
  });
});
