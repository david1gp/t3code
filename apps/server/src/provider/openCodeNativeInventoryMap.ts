import type {
  ServerProviderModel,
  ServerProviderSkill,
  ServerProviderSlashCommand,
  ProviderOptionDescriptor,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import type { OpenCodeNativeInventory } from "./openCodeNativeInventorySchema.ts";
import { COMPACT_SLASH_COMMAND } from "./providerSnapshot.ts";

const trimmed = (value: string | undefined) => value?.trim() || undefined;
const label = (value: string) =>
  value
    .split(/[-_/]+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

/** Convert v2.0.18 inventory to the existing provider snapshot fields. */
export const openCodeNativeInventoryMap = (
  inventory: OpenCodeNativeInventory,
  machineModels?: ReadonlyArray<ServerProviderModel>,
): {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly connectedCount: number;
} => {
  const providers = new Map(
    inventory.provider
      .filter((provider) => provider.activation !== "disabled")
      .map((provider) => [provider.id, provider]),
  );
  const agents = inventory.agent.filter(
    (agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"),
  );
  // v2 resolves agents by `id`; `name` is a display label (e.g. "Build").
  // Native inventory lists the resolved default first, including configured agents.
  const defaultAgent = agents[0]?.id;
  const agentDescriptor: ProviderOptionDescriptor | undefined =
    agents.length > 0
      ? {
          id: "agent",
          label: "Agent",
          type: "select",
          options: agents.map((agent) => ({
            id: agent.id,
            label: trimmed(agent.name) ?? label(agent.id),
            ...(agent.id === defaultAgent ? { isDefault: true as const } : {}),
          })),
          ...(defaultAgent ? { currentValue: defaultAgent } : {}),
        }
      : undefined;
  const models: ServerProviderModel[] = [];
  for (const model of inventory.model) {
    const provider = providers.get(model.providerID);
    const name = trimmed(model.name);
    if (!provider || !model.enabled || !name || !trimmed(model.id)) continue;
    const variants = [
      ...new Set(model.variants.map((variant) => variant.id).filter((id) => trimmed(id))),
    ];
    const costs = model.cost ?? [];
    const baseCost = costs.find((cost) => cost.tier === undefined);
    const tierCosts = costs.flatMap((cost) =>
      cost.tier
        ? [
            {
              inputTokensAbove: cost.tier.size,
              input: cost.input,
              output: cost.output,
              cache: cost.cache,
            },
          ]
        : [],
    );
    const limits = model.limit
      ? {
          ...(model.limit.context !== undefined ? { context: model.limit.context } : {}),
          ...(model.limit.input !== undefined ? { input: model.limit.input } : {}),
          ...(model.limit.output !== undefined ? { output: model.limit.output } : {}),
        }
      : undefined;
    const metadata = {
      ...(limits && Object.keys(limits).length > 0 ? { limits } : {}),
      ...(model.capabilities?.input !== undefined || model.capabilities?.output !== undefined
        ? {
            modalities: {
              ...(model.capabilities.input !== undefined
                ? { input: model.capabilities.input }
                : {}),
              ...(model.capabilities.output !== undefined
                ? { output: model.capabilities.output }
                : {}),
            },
          }
        : {}),
      ...(model.capabilities?.tools !== undefined ? { tools: model.capabilities.tools } : {}),
      ...(costs.length > 0
        ? {
            pricing: {
              unit: "usd_per_million_tokens" as const,
              ...(baseCost
                ? {
                    base: {
                      input: baseCost.input,
                      output: baseCost.output,
                      cache: baseCost.cache,
                    },
                  }
                : {}),
              ...(tierCosts.length > 0 ? { tiers: tierCosts } : {}),
            },
          }
        : {}),
    };
    models.push({
      slug: `${provider.id}/${model.id}`,
      name,
      ...(trimmed(provider.name) ? { subProvider: provider.name.trim() } : {}),
      isCustom: false,
      metadata,
      capabilities: createModelCapabilities({
        optionDescriptors: [
          ...(variants.length > 0
            ? [
                {
                  id: "variant",
                  label: "Reasoning",
                  type: "select" as const,
                  options: variants.map((id) => ({ id, label: label(id) })),
                },
              ]
            : []),
          ...(agentDescriptor ? [agentDescriptor] : []),
        ],
      }),
    });
  }
  const skills: ServerProviderSkill[] = inventory.skill.flatMap((skill) => {
    const name = trimmed(skill.name);
    const path = trimmed(skill.path);
    if (!name || !path) return [];
    const description = trimmed(skill.description);
    return [
      {
        name,
        path,
        enabled: true,
        ...(description ? { description, shortDescription: description } : {}),
      },
    ];
  });
  const slashCommands: ServerProviderSlashCommand[] = [COMPACT_SLASH_COMMAND];
  const names = new Set([COMPACT_SLASH_COMMAND.name]);
  for (const command of inventory.command) {
    const name = trimmed(command.name);
    if (!name || names.has(name)) continue;
    names.add(name);
    const description = trimmed(command.description);
    slashCommands.push({ name, ...(description ? { description } : {}) });
  }
  return {
    models: machineModels
      ? machineModels.map((model) => ({
          ...model,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              ...(model.capabilities?.optionDescriptors ?? []).filter(
                (entry) => entry.id !== "agent",
              ),
              ...(agentDescriptor ? [agentDescriptor] : []),
            ],
          }),
        }))
      : models.toSorted((left, right) => left.name.localeCompare(right.name)),
    skills: skills.toSorted((left, right) => left.name.localeCompare(right.name)),
    slashCommands,
    // /api/provider already returns the available (connected) providers, even
    // when a provider currently exposes no enabled models.
    connectedCount: providers.size,
  };
};
