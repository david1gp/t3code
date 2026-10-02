import type { ServerProvider, ServerProviderWorkspaceSnapshot } from "@t3tools/contracts";

/** Keep native cwd agent defaults without copying the workspace model catalog. */
export function providerWorkspaceSnapshotCreate(
  cwd: string,
  scopedSnapshot: ServerProvider,
): ServerProviderWorkspaceSnapshot {
  return {
    cwd,
    checkedAt: scopedSnapshot.checkedAt,
    slashCommands: scopedSnapshot.slashCommands,
    skills: scopedSnapshot.skills,
    ...(scopedSnapshot.driver === "opencode"
      ? {
          modelOptionOverlays: scopedSnapshot.models.map((model) => ({
            slug: model.slug,
            optionDescriptors:
              model.capabilities?.optionDescriptors?.filter(
                (descriptor) => descriptor.id === "agent",
              ) ?? [],
          })),
        }
      : {}),
  };
}
