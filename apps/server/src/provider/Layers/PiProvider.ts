import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type PiSettings, type ServerProvider, type ServerProviderModel } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { createModelCapabilities } from "@t3tools/shared/model";
import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PRESENTATION = {
  displayName: "Pi",
  supportsConversationRollback: false,
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
type PiSdkModel = Pick<
  ReturnType<ModelRuntime["getModels"]>[number],
  "provider" | "id" | "name" | "reasoning" | "thinkingLevelMap"
>;
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies ReadonlyArray<keyof NonNullable<PiSdkModel["thinkingLevelMap"]>>;
const THINKING_LEVEL_LABELS = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

function piModelCapabilities(model: PiSdkModel) {
  if (!model.reasoning) return EMPTY_CAPABILITIES;
  // Match the SDK: null disables a level; xhigh/max require an explicit mapping.
  const levels = THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  });
  // Pi defaults to medium, clamping upward first and then downward when unsupported.
  const defaultLevel =
    levels.find((level) => THINKING_LEVELS.indexOf(level) >= THINKING_LEVELS.indexOf("medium")) ??
    levels.at(-1);
  if (!defaultLevel) return EMPTY_CAPABILITIES;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "thinkingLevel",
        label: "Reasoning",
        type: "select",
        options: levels.map((level) => ({
          id: level,
          label: THINKING_LEVEL_LABELS[level],
          ...(level === defaultLevel ? { isDefault: true } : {}),
        })),
        currentValue: defaultLevel,
      },
    ],
  });
}

export function piModelsFromSdk(
  models: ReadonlyArray<PiSdkModel>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return models.flatMap((model): ServerProviderModel[] => {
    const slug = `${model.provider}/${model.id}`;
    if (seen.has(slug)) return [];
    seen.add(slug);
    const name = model.name.trim() || model.id;
    return [{ slug, name, isCustom: false, capabilities: piModelCapabilities(model) }];
  });
}

export function piAuthFromSdk(
  runtime: {
    readonly getModels: () => ReadonlyArray<{ readonly provider: string }>;
    readonly getRegisteredProviderIds: () => ReadonlyArray<string>;
    readonly getProviderAuthStatus: (provider: string) => { readonly configured: boolean };
  },
  models: ReadonlyArray<{ readonly provider: string }> = runtime.getModels(),
) {
  const providerIds = new Set([
    ...runtime.getRegisteredProviderIds(),
    ...models.map((model) => model.provider),
  ]);
  const configured = [...providerIds].some(
    (provider) => runtime.getProviderAuthStatus(provider).configured,
  );
  return { status: configured ? "authenticated" : "unauthenticated" } as const;
}

export function buildInitialPiProviderSnapshot(
  settings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, DateTime.formatIso).pipe(
    Effect.map((checkedAt) =>
      buildServerProvider({
        presentation: PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: providerModelsFromSettings([], settings.customModels, EMPTY_CAPABILITIES),
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: settings.enabled
            ? "Checking embedded Pi SDK availability..."
            : "Pi is disabled in settings.",
        },
      }),
    ),
  );
}

export function buildPiProviderSnapshot(input: {
  readonly settings: PiSettings;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly installed: boolean;
  readonly version?: string | null;
  readonly auth?: ServerProvider["auth"];
  readonly message?: string;
}): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, DateTime.formatIso).pipe(
    Effect.map((checkedAt) =>
      buildServerProvider({
        presentation: PRESENTATION,
        enabled: input.settings.enabled,
        checkedAt,
        models: providerModelsFromSettings(
          input.models,
          input.settings.customModels,
          EMPTY_CAPABILITIES,
        ),
        probe: {
          installed: input.installed,
          version: input.version ?? null,
          status: input.message ? "warning" : "ready",
          auth: input.auth ?? { status: "unknown" },
          ...(input.message ? { message: input.message } : {}),
        },
      }),
    ),
  );
}

export function enrichPiSnapshot(
  snapshot: ServerProvider,
  models: ReadonlyArray<ServerProviderModel>,
): ServerProvider {
  return { ...snapshot, models: providerModelsFromSettings(models, [], EMPTY_CAPABILITIES) };
}
