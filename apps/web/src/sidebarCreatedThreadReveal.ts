import { getProjectOrderKey } from "./logicalProject";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "./uiStateStore";

export function sidebarCreatedThreadReveal(input: {
  grouped: boolean;
  logicalProjectKey: string;
  project?: Pick<EnvironmentProject, "environmentId" | "workspaceRoot"> | null;
}) {
  if (!input.grouped) return;
  const ui = useUiStateStore.getState();
  if (ui.sidebarProjectScopeKey !== null && ui.sidebarProjectScopeKey !== input.logicalProjectKey)
    ui.setSidebarProjectScopeKey(input.logicalProjectKey);
  ui.setProjectExpanded(
    [
      input.logicalProjectKey,
      ...(input.project
        ? [
            getProjectOrderKey(input.project),
            legacyProjectCwdPreferenceKey(input.project.workspaceRoot),
          ]
        : []),
    ],
    true,
  );
}
