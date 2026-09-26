import { describe, expect, it } from "vite-plus/test";
import { checkoutPickerAvailable } from "./checkoutPickerAvailable";

const available = {
  hasActiveThread: true,
  hasActiveProject: true,
  isGitRepo: true,
  envLocked: false,
  hasMultipleModelSelections: false,
  hasPinnedServerWorktree: false,
};

describe("checkoutPickerAvailable", () => {
  it("allows checkout selection for an unlocked Git thread", () => {
    expect(checkoutPickerAvailable(available)).toBe(true);
  });

  it.each([
    ["no thread", { hasActiveThread: false }],
    ["no project", { hasActiveProject: false }],
    ["non-Git project", { isGitRepo: false }],
    ["locked thread", { envLocked: true }],
    ["multiple model selections", { hasMultipleModelSelections: true }],
    ["server worktree", { hasPinnedServerWorktree: true }],
  ])("does not offer a checkout picker for %s", (_reason, override) => {
    expect(checkoutPickerAvailable({ ...available, ...override })).toBe(false);
  });
});
