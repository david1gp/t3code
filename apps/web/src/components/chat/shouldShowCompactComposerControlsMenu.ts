export function shouldShowCompactComposerControlsMenu(input: {
  hiddenBlockCount: number;
  showInlineAccessMode: boolean;
  composerControlsHidden: boolean;
}) {
  if (input.composerControlsHidden) return false;

  return input.hiddenBlockCount > 0 || !input.showInlineAccessMode;
}
