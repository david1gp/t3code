import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";

export function sidebarGroupedDraftBelongsToProject(
  draft: { environmentId: string; projectId: string },
  project: Pick<SidebarProjectSnapshot, "memberProjectRefs">,
) {
  return project.memberProjectRefs.some(
    (ref) => ref.environmentId === draft.environmentId && ref.projectId === draft.projectId,
  );
}
