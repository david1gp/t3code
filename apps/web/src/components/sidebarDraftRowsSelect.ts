import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { sidebarGroupedDraftBelongsToProject } from "./sidebarGroupedDraftBelongsToProject";

export function sidebarDraftRowsSelect<
  Session extends {
    environmentId: string;
    projectId: string;
    promotedTo?: unknown;
    createdAt: string;
  },
  Composer,
>(input: {
  sessions: Readonly<Record<string, Session>>;
  composers: Readonly<Record<string, Composer>>;
  scope: ReadonlySet<string> | null;
  groupProject?: Pick<SidebarProjectSnapshot, "memberProjectRefs">;
  activeDraftId: string | null;
  frozenActive: {
    routeDraftId: string | null;
    row: { draftId: string; session: Session; composer: Composer | null } | null;
  };
  hasContent: (composer: Composer | undefined) => boolean;
}) {
  const rows: { draftId: string; session: Session; composer: Composer | null }[] = [];
  for (const [draftId, session] of Object.entries(input.sessions)) {
    if (session.promotedTo != null) continue;
    if (input.scope !== null && !input.scope.has(`${session.environmentId}:${session.projectId}`))
      continue;
    if (input.groupProject && !sidebarGroupedDraftBelongsToProject(session, input.groupProject))
      continue;
    if (draftId === input.activeDraftId) {
      if (input.frozenActive.routeDraftId === draftId && input.frozenActive.row !== null)
        rows.push(input.frozenActive.row);
      else if (input.groupProject) rows.push({ draftId, session, composer: null });
      continue;
    }
    const composer = input.composers[draftId];
    if (!input.groupProject && !input.hasContent(composer)) continue;
    rows.push({ draftId, session, composer: composer ?? null });
  }
  rows.sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt));
  return rows;
}
