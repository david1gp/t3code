import type {
  ServerProviderModel,
  ServerProviderSkill,
  ServerProviderSlashCommand,
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
  const defaultAgent = agents.find((agent) => agent.name === "build")?.name ?? agents[0]?.name;
  const models: ServerProviderModel[] = [];
  for (const model of inventory.model) {
    const provider = providers.get(model.providerID);
    const name = trimmed(model.name);
    if (!provider || !model.enabled || !name || !trimmed(model.id)) continue;
    const variants = [
      ...new Set(model.variants.map((variant) => variant.id).filter((id) => trimmed(id))),
    ];
    models.push({
      slug: `${provider.id}/${model.id}`,
      name,
      ...(trimmed(provider.name) ? { subProvider: provider.name.trim() } : {}),
      isCustom: false,
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
          ...(agents.length > 0
            ? [
                {
                  id: "agent",
                  label: "Agent",
                  type: "select" as const,
                  options: agents.map((agent) => ({
                    id: agent.name,
                    label: label(agent.name),
                    ...(agent.name === defaultAgent ? { isDefault: true as const } : {}),
                  })),
                  ...(defaultAgent ? { currentValue: defaultAgent } : {}),
                },
              ]
            : []),
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
    models: models.toSorted((left, right) => left.name.localeCompare(right.name)),
    skills: skills.toSorted((left, right) => left.name.localeCompare(right.name)),
    slashCommands,
    // /api/provider already returns the available (connected) providers, even
    // when a provider currently exposes no enabled models.
    connectedCount: providers.size,
  };
};
