import { describe, expect, it } from "vite-plus/test";

import { shouldShowCompactComposerControlsMenu } from "./shouldShowCompactComposerControlsMenu";
import { getCompactComposerMenuShortcuts } from "./getCompactComposerMenuShortcuts";
import { providerSupportsRuntimeMode } from "../settings/providerSupportsRuntimeMode";
import { ProviderDriverKind } from "@t3tools/contracts";

const defaults = {
  hasOverflowedTraits: false,
  hasOverflowedPlanMode: false,
  hasOverflowedAccessMode: false,
  showCompactComposerMenu: true,
  composerControlsHidden: false,
};

describe("shouldShowCompactComposerControlsMenu", () => {
  it("hides the ellipsis when overflow contains no actionable menu controls", () => {
    expect(shouldShowCompactComposerControlsMenu(defaults)).toBe(false);
  });

  it.each([
    ["provider traits", { hasOverflowedTraits: true }],
    ["Plan mode", { hasOverflowedPlanMode: true }],
    ["visible Access", { hasOverflowedAccessMode: true }],
  ] as const)("shows the ellipsis for overflowed %s", (_control, overflow) => {
    expect(shouldShowCompactComposerControlsMenu({ ...defaults, ...overflow })).toBe(true);
  });

  it("does not count hidden inline Access as actionable overflow", () => {
    expect(
      shouldShowCompactComposerControlsMenu({
        ...defaults,
        hasOverflowedAccessMode: false,
      }),
    ).toBe(false);
  });

  it("does not advertise an access shortcut or overflow for Pi, while retaining traits", () => {
    const showAccess = providerSupportsRuntimeMode(ProviderDriverKind.make("pi"));
    expect(getCompactComposerMenuShortcuts(showAccess, true)).toBe("composer.effort");
    expect(
      shouldShowCompactComposerControlsMenu({
        ...defaults,
        hasOverflowedAccessMode: showAccess,
        hasOverflowedTraits: true,
      }),
    ).toBe(true);
    expect(
      shouldShowCompactComposerControlsMenu({
        ...defaults,
        hasOverflowedAccessMode: showAccess,
      }),
    ).toBe(false);
  });

  it("hides actionable overflow when the preference is off", () => {
    expect(
      shouldShowCompactComposerControlsMenu({
        ...defaults,
        hasOverflowedTraits: true,
        showCompactComposerMenu: false,
      }),
    ).toBe(false);
  });

  it("preserves hidden composer controls precedence", () => {
    expect(
      shouldShowCompactComposerControlsMenu({
        ...defaults,
        hasOverflowedPlanMode: true,
        composerControlsHidden: true,
      }),
    ).toBe(false);
  });
});

describe("getCompactComposerMenuShortcuts", () => {
  it("does not advertise Access when inline Access is hidden", () => {
    expect(getCompactComposerMenuShortcuts(false, true)).toBe("composer.effort");
    expect(getCompactComposerMenuShortcuts(false, false)).toBeUndefined();
  });

  it("advertises available Access and provider traits shortcuts", () => {
    expect(getCompactComposerMenuShortcuts(true, true)).toBe("composer.mode composer.effort");
    expect(getCompactComposerMenuShortcuts(true, false)).toBe("composer.mode");
  });
});
