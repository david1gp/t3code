import type { Skill } from "@earendil-works/pi-coding-agent";
import type { ServerProviderSkill } from "@t3tools/contracts";

/** Preserve the SDK's loaded skill order, collision winners, and original file paths. */
export function piSkillsToServerProviderSkills(
  skills: ReadonlyArray<Pick<Skill, "name" | "description" | "filePath" | "sourceInfo">>,
): ReadonlyArray<ServerProviderSkill> {
  return skills.map((skill) => {
    const description = skill.description.trim();
    return {
      name: skill.name,
      path: skill.filePath,
      enabled: true,
      scope: skill.sourceInfo.scope,
      ...(description ? { description } : {}),
    };
  });
}
