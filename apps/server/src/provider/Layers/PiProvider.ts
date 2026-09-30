import type { ModelRuntime, PromptTemplate } from "@earendil-works/pi-coding-agent";
import {
  type PiSettings,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
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

export function piPresetNamesFromJson(value: unknown): ReadonlyArray<string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter(
      ([name, preset]) =>
        name !== "none" &&
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) &&
        typeof preset === "object" &&
        preset !== null &&
        !Array.isArray(preset),
    )
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));
}

function piCapabilities(model: PiSdkModel, presetNames: ReadonlyArray<string>) {
  const capabilities = piModelCapabilities(model);
  if (presetNames.length === 0) return capabilities;
  const presetDescriptor = {
    id: "preset",
    label: "Preset",
    type: "select" as const,
    options: [
      { id: "none", label: "Default" },
      ...presetNames.map((name) => ({ id: name, label: name })),
    ],
  };
  return createModelCapabilities({
    optionDescriptors: [...(capabilities.optionDescriptors ?? []), presetDescriptor],
  });
}

export function piModelsFromSdk(
  models: ReadonlyArray<PiSdkModel>,
  presetNames: ReadonlyArray<string> = [],
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return models.flatMap((model): ServerProviderModel[] => {
    const slug = `${model.provider}/${model.id}`;
    if (seen.has(slug)) return [];
    seen.add(slug);
    const name = model.name.trim() || model.id;
    return [{ slug, name, isCustom: false, capabilities: piCapabilities(model, presetNames) }];
  });
}

/** Map Pi prompt templates to the slash menu in SDK expansion order. */
export function piPromptTemplatesToSlashCommands(
  templates: ReadonlyArray<Pick<PromptTemplate, "name" | "description" | "argumentHint">>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  return templates.flatMap((template) => {
    const name = template.name.trim();
    // Pi's template expander requires the whole first token to match exactly;
    // malformed names and duplicates later in discovery order are not invokable.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || seen.has(name)) return [];
    seen.add(name);
    const description = template.description.trim();
    const hint = template.argumentHint?.trim();
    return [
      {
        name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      },
    ];
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
