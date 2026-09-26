export function getCompactComposerMenuShortcuts(
  showAccessModeControl: boolean,
  hasTraitsMenuContent: boolean,
) {
  return (
    [
      showAccessModeControl ? "composer.mode" : null,
      hasTraitsMenuContent ? "composer.effort" : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined
  );
}
