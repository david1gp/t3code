export function shouldShowCompactComposerControlsMenu(input: {
  hasOverflowedTraits: boolean;
  hasOverflowedPlanMode: boolean;
  hasOverflowedAccessMode: boolean;
  showCompactComposerMenu: boolean;
  composerControlsHidden: boolean;
}) {
  if (input.composerControlsHidden) return false;
  if (!input.showCompactComposerMenu) return false;

  return input.hasOverflowedTraits || input.hasOverflowedPlanMode || input.hasOverflowedAccessMode;
}
