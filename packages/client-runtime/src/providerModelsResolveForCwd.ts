import type { ServerProvider } from "@t3tools/contracts";

/** Resolve workspace agent choices without replacing the machine model catalog. */
export function providerModelsResolveForCwd(
  provider: ServerProvider,
  cwd: string | null | undefined,
): ServerProvider["models"] {
  if (!cwd) return provider.models;
  const overlays = provider.workspaceSnapshots?.find(
    (snapshot) => snapshot.cwd === cwd,
  )?.modelOptionOverlays;
  if (!overlays?.length) return provider.models;

  const overlaysBySlug = new Map(overlays.map((overlay) => [overlay.slug, overlay]));
  return provider.models.map((model) => {
    const overlay = overlaysBySlug.get(model.slug);
    if (!overlay) return model;

    const agent = overlay.optionDescriptors.find((descriptor) => descriptor.id === "agent");
    const descriptors = model.capabilities?.optionDescriptors ?? [];
    const hasAgent = descriptors.some((descriptor) => descriptor.id === "agent");
    if (!agent && !hasAgent) return model;

    const optionDescriptors = descriptors.flatMap((descriptor) => {
      if (descriptor.id !== "agent") return [descriptor];
      return agent ? [agent] : [];
    });
    if (agent && !hasAgent) optionDescriptors.push(agent);
    return {
      ...model,
      capabilities: { ...model.capabilities, optionDescriptors },
    };
  });
}
