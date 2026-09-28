import {
  buildModelOptions,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
} from "../../lib/modelOptions";
import { providerSupportsRuntimeMode } from "../../lib/providerSupportsRuntimeMode";
import type { ScopedMobileSettingsTarget } from "./settings-scoped-server";

/** Keep the shared default visible if any selected environment uses another provider. */
export function mobileDefaultRuntimeModeVisible(
  targets: readonly ScopedMobileSettingsTarget[],
): boolean {
  if (targets.length === 0) return true;
  return targets.some((target) => {
    const config = target.environment.serverConfig;
    const selection = resolveDefaultableModelSelection(
      config,
      target.settings.defaultModelSelection,
    );
    const effective =
      selection ??
      resolveNewTaskModelSelection({
        draftSelection: null,
        projectDefaultSelection: null,
        stickySelection: null,
        modelOptions: buildModelOptions(config, null),
      });
    const driver =
      effective === null
        ? undefined
        : (config.providers.find((provider) => provider.instanceId === effective.instanceId)
            ?.driver ?? config.settings.providerInstances?.[effective.instanceId]?.driver);
    return providerSupportsRuntimeMode(driver);
  });
}
