export function checkoutPickerAvailable(input: {
  hasActiveThread: boolean;
  hasActiveProject: boolean;
  isGitRepo: boolean;
  envLocked: boolean;
  hasMultipleModelSelections: boolean;
  hasPinnedServerWorktree: boolean;
}): boolean {
  return (
    input.hasActiveThread &&
    input.hasActiveProject &&
    input.isGitRepo &&
    !input.envLocked &&
    !input.hasMultipleModelSelections &&
    !input.hasPinnedServerWorktree
  );
}
