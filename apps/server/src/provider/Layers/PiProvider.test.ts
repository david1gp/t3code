import { describe, expect, it } from "@effect/vitest";
import { PiSettings, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { piSkillsToServerProviderSkills } from "../piSkillsToServerProviderSkills.ts";
import {
  buildInitialPiProviderSnapshot,
  buildPiProviderSnapshot,
  enrichPiSnapshot,
  piAuthFromSdk,
  piModelsFromSdk,
  piPresetNamesFromJson,
  piPromptTemplatesToSlashCommands,
} from "./PiProvider.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const customCapabilities = {
  optionDescriptors: [
    {
      id: "thinkingLevel",
      label: "Reasoning",
      type: "select",
      options: [{ id: "low", label: "Low", isDefault: true }],
      currentValue: "low",
    },
  ],
} as const;

describe("Pi provider catalog", () => {
  it("maps loaded skill metadata without normalizing paths or filtering native names", () => {
    const sourceInfo = {
      path: "/shared/real/SKILL.md",
      source: "auto",
      scope: "project" as const,
      origin: "top-level" as const,
    };
    expect(
      piSkillsToServerProviderSkills([
        {
          name: "assets",
          description: " Asset instructions ",
          filePath: "/project/.pi/skills/assets-link/SKILL.md",
          sourceInfo,
        },
        {
          name: "Legacy_Name",
          description: "  ",
          filePath: "/home/agent/skills/legacy/SKILL.md",
          sourceInfo: { ...sourceInfo, scope: "user" },
        },
      ]),
    ).toEqual([
      {
        name: "assets",
        description: "Asset instructions",
        path: "/project/.pi/skills/assets-link/SKILL.md",
        scope: "project",
        enabled: true,
      },
      {
        name: "Legacy_Name",
        path: "/home/agent/skills/legacy/SKILL.md",
        scope: "user",
        enabled: true,
      },
    ]);
  });

  it("maps invokable prompt metadata and keeps Pi's first-name-wins collision behavior", () => {
    expect(
      piPromptTemplatesToSlashCommands([
        { name: "global", description: " Global description ", argumentHint: " <topic> " },
        { name: "shared", description: "Global version", argumentHint: " [args] " },
        { name: "shared", description: "Project version", argumentHint: "ignored" },
        { name: "", description: "invalid" },
        { name: "not invokable/name", description: "invalid" },
        { name: "plain", description: "  ", argumentHint: " " },
      ]),
    ).toEqual([
      { name: "global", description: "Global description", input: { hint: "<topic>" } },
      { name: "shared", description: "Global version", input: { hint: "[args]" } },
      { name: "plain" },
    ]);
  });

  it("deduplicates provider/model records without changing their slugs or names", () => {
    expect(
      piModelsFromSdk([
        { provider: "anthropic", id: "claude-3", name: "Claude 3", reasoning: false },
        { provider: "anthropic", id: "claude-3", name: "duplicate", reasoning: false },
        { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true },
      ]).map(({ slug, name }) => ({ slug, name })),
    ).toEqual([
      { slug: "anthropic/claude-3", name: "Claude 3" },
      { slug: "openai/gpt-5", name: "GPT-5" },
    ]);
  });

  it("advertises standard SDK thinking levels with medium as the default", () => {
    const [model] = piModelsFromSdk([
      { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true },
    ]);
    expect(model?.capabilities).toEqual({
      optionDescriptors: [
        {
          id: "thinkingLevel",
          label: "Reasoning",
          type: "select",
          options: [
            { id: "off", label: "Off" },
            { id: "minimal", label: "Minimal" },
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
          ],
          currentValue: "medium",
        },
      ],
    });
  });

  it("discovers valid preset entries and exposes them alongside thinking choices", () => {
    const presets = piPresetNamesFromJson({
      delegate: { model: "a/model" },
      build: { model: "b/model" },
      none: { model: "reserved" },
      "two words": { model: "invalid" },
      "bad/name": { model: "invalid" },
      invalid: null,
    });
    expect(presets).toEqual(["build", "delegate"]);
    const [model] = piModelsFromSdk(
      [{ provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true }],
      presets,
    );
    expect(model?.capabilities?.optionDescriptors).toEqual([
      {
        id: "thinkingLevel",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "off", label: "Off" },
          { id: "minimal", label: "Minimal" },
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium", isDefault: true },
          { id: "high", label: "High" },
        ],
        currentValue: "medium",
      },
      {
        id: "preset",
        label: "Preset",
        type: "select",
        options: [
          { id: "none", label: "Default" },
          { id: "build", label: "build" },
          { id: "delegate", label: "delegate" },
        ],
      },
    ]);
  });

  it.each([null, [], "bad", { invalid: null }])(
    "safely omits preset choices for invalid or empty config %#",
    (config) => {
      expect(piPresetNamesFromJson(config)).toEqual([]);
      const [model] = piModelsFromSdk(
        [{ provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: false }],
        piPresetNamesFromJson(config),
      );
      expect(model?.capabilities).toEqual({ optionDescriptors: [] });
    },
  );

  it.each([
    {
      behavior: "opts into mapped xhigh/max and excludes null levels",
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "native-low",
        xhigh: "native-extra",
        max: "native-max",
      },
      levels: ["low", "medium", "high", "xhigh", "max"],
      defaultLevel: "medium",
    },
    {
      behavior: "clamps the medium default upward before considering lower levels",
      thinkingLevelMap: {
        off: null,
        minimal: null,
        medium: null,
        high: "native-high",
        xhigh: null,
        max: "native-max",
      },
      levels: ["low", "high", "max"],
      defaultLevel: "high",
    },
    {
      behavior: "clamps the medium default downward when no higher level is supported",
      thinkingLevelMap: {
        off: null,
        minimal: null,
        medium: null,
        high: null,
        xhigh: null,
        max: null,
      },
      levels: ["low"],
      defaultLevel: "low",
    },
    {
      behavior: "uses off as the default when it is the only supported level",
      thinkingLevelMap: {
        minimal: null,
        low: null,
        medium: null,
        high: null,
        xhigh: null,
        max: null,
      },
      levels: ["off"],
      defaultLevel: "off",
    },
  ])("$behavior for custom SDK model metadata", ({ thinkingLevelMap, levels, defaultLevel }) => {
    const [model] = piModelsFromSdk([
      { provider: "custom", id: "reasoner", name: "Reasoner", reasoning: true, thinkingLevelMap },
    ]);
    const descriptor = model?.capabilities?.optionDescriptors?.[0];
    expect(descriptor).toMatchObject({
      id: "thinkingLevel",
      type: "select",
      currentValue: defaultLevel,
    });
    if (descriptor?.type !== "select") return;
    expect(descriptor.options.map((option) => option.id)).toEqual(levels);
    expect(
      descriptor.options.filter((option) => option.isDefault).map((option) => option.id),
    ).toEqual([defaultLevel]);
  });

  it("does not advertise reasoning for non-reasoning models even with a thinking map", () => {
    const [model] = piModelsFromSdk([
      {
        provider: "custom",
        id: "plain",
        name: "Plain",
        reasoning: false,
        thinkingLevelMap: { xhigh: "native-extra", max: "native-max" },
      },
    ]);
    expect(model?.capabilities).toEqual({ optionDescriptors: [] });
  });

  it("omits the selector when a reasoning model disables every SDK level", () => {
    const [model] = piModelsFromSdk([
      {
        provider: "custom",
        id: "disabled",
        name: "Disabled",
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: null,
          medium: null,
          high: null,
          xhigh: null,
          max: null,
        },
      },
    ]);
    expect(model?.capabilities).toEqual({ optionDescriptors: [] });
  });

  it.effect(
    "preserves SDK reasoning capabilities and explicit custom capabilities in snapshots",
    () =>
      Effect.gen(function* () {
        const models = piModelsFromSdk([
          { provider: "custom", id: "reasoner", name: "Reasoner", reasoning: true },
          { provider: "custom", id: "plain", name: "Plain", reasoning: false },
        ]);
        const settings = decodePiSettings({
          customModels: [
            "custom/reasoner",
            { slug: "custom/plain", capabilities: customCapabilities },
            "custom/unlisted",
            { slug: "custom/declared", name: "Declared", capabilities: customCapabilities },
          ],
        });
        const snapshot = yield* buildPiProviderSnapshot({ settings, models, installed: true });
        expect(snapshot.models).toEqual([
          ...models,
          {
            slug: "custom/unlisted",
            name: "custom/unlisted",
            isCustom: true,
            capabilities: { optionDescriptors: [] },
          },
          {
            slug: "custom/declared",
            name: "Declared",
            isCustom: true,
            capabilities: customCapabilities,
          },
        ]);

        const initial = yield* buildInitialPiProviderSnapshot(decodePiSettings({}));
        const initialSnapshot = {
          ...initial,
          instanceId: ProviderInstanceId.make("pi"),
          driver: ProviderDriverKind.make("pi"),
        };
        expect(enrichPiSnapshot(initialSnapshot, snapshot.models)).toEqual({
          ...initialSnapshot,
          models: snapshot.models,
        });
      }),
  );

  it.effect("does not invent reasoning metadata for custom slugs before SDK discovery", () =>
    Effect.gen(function* () {
      const settings = decodePiSettings({
        customModels: [
          "openai/gpt-5",
          { slug: "custom/declared", name: "Declared", capabilities: customCapabilities },
        ],
      });
      const snapshot = yield* buildInitialPiProviderSnapshot(settings);
      expect(snapshot.models).toEqual([
        {
          slug: "openai/gpt-5",
          name: "openai/gpt-5",
          isCustom: true,
          capabilities: { optionDescriptors: [] },
        },
        {
          slug: "custom/declared",
          name: "Declared",
          isCustom: true,
          capabilities: customCapabilities,
        },
      ]);
    }),
  );

  it.effect(
    "keeps an unavailable SDK warning and unknown auth without inventing model availability",
    () =>
      Effect.gen(function* () {
        const settings = decodePiSettings({ enabled: true });
        const snapshot = yield* buildPiProviderSnapshot({
          settings,
          models: [],
          installed: false,
          message: "Pi unavailable",
        });
        expect(snapshot).toMatchObject({
          enabled: true,
          installed: false,
          status: "warning",
          auth: { status: "unknown" },
          models: [],
          message: "Pi unavailable",
        });
      }),
  );

  it("counts configured custom model providers and ignores catalog-only providers", () => {
    const runtime = {
      getRegisteredProviderIds: () => ["anthropic", "openai"],
      getModels: () => [
        { provider: "codex-lb", id: "gpt-6-luna" },
        { provider: "catalog-only", id: "model" },
      ],
      getProviderAuthStatus: (provider: string) => ({
        configured: provider === "codex-lb",
        ...(provider === "codex-lb" ? { source: "environment" as const } : {}),
      }),
    };
    expect(piAuthFromSdk(runtime)).toEqual({ status: "authenticated" });
    expect(
      piAuthFromSdk({
        ...runtime,
        getProviderAuthStatus: () => ({ configured: false }),
      }),
    ).toEqual({ status: "unauthenticated" });
  });

  it.effect("starts enabled while checking the SDK without fabricating a catalog", () =>
    Effect.gen(function* () {
      const settings = decodePiSettings({});
      const snapshot = yield* buildInitialPiProviderSnapshot(settings);
      expect(snapshot).toMatchObject({
        enabled: true,
        status: "warning",
        auth: { status: "unknown" },
        models: [],
        message: "Checking embedded Pi SDK availability...",
      });
    }),
  );
});
