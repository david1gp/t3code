import type { ScopedSettingsTarget } from "./scopedSettings";
import type { ResolvedSettingsScope } from "./settingsScope";

/** Global settings use machine inventory; project choices use the target's checkout. */
export function settingsScopeCwdResolve(
  scope: ResolvedSettingsScope,
  target: Pick<ScopedSettingsTarget, "environmentId" | "projectId"> | null,
): string | null {
  if (!target || (scope.kind !== "project" && scope.kind !== "checkout")) return null;
  return (
    scope.members.find(
      (member) => member.environmentId === target.environmentId && member.id === target.projectId,
    )?.workspaceRoot ?? null
  );
}
