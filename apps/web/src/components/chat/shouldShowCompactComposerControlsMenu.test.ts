import { describe, expect, it } from "vite-plus/test";

import { shouldShowCompactComposerControlsMenu } from "./shouldShowCompactComposerControlsMenu";

describe("shouldShowCompactComposerControlsMenu", () => {
  it("keeps the compact menu hidden when all controls fit and inline access is shown", () => {
    expect(
      shouldShowCompactComposerControlsMenu({
        hiddenBlockCount: 0,
        showInlineAccessMode: true,
        composerControlsHidden: false,
      }),
    ).toBe(false);
  });

  it("shows the compact menu as the access-mode route when inline access is hidden", () => {
    expect(
      shouldShowCompactComposerControlsMenu({
        hiddenBlockCount: 0,
        showInlineAccessMode: false,
        composerControlsHidden: false,
      }),
    ).toBe(true);
  });

  it("keeps the compact menu hidden while composer controls are hidden, even with overflow", () => {
    expect(
      shouldShowCompactComposerControlsMenu({
        hiddenBlockCount: 2,
        showInlineAccessMode: false,
        composerControlsHidden: true,
      }),
    ).toBe(false);
  });
});
