import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { type ReactNode } from "react";
import { MenuRadioGroup, MenuRadioItem, MenuSeparator as MenuDivider } from "../ui/menu";
import { shouldShowCompactComposerAccessMode } from "./shouldShowCompactComposerAccessMode";

export function CompactComposerControlsMenuContent(props: {
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  showAccessModeControl: boolean;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  return (
    <>
      {props.traitsMenuContent ? (
        <>
          {props.traitsMenuContent}
          {props.showInteractionModeToggle || props.showAccessModeControl ? <MenuDivider /> : null}
        </>
      ) : null}
      {props.showInteractionModeToggle ? (
        <>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
          <MenuRadioGroup
            value={props.interactionMode}
            onValueChange={(value) => {
              if (!value || value === props.interactionMode) return;
              props.onToggleInteractionMode();
            }}
          >
            <MenuRadioItem value="default">Chat</MenuRadioItem>
            <MenuRadioItem value="plan">Plan</MenuRadioItem>
          </MenuRadioGroup>
          {props.showAccessModeControl ? <MenuDivider /> : null}
        </>
      ) : null}
      {shouldShowCompactComposerAccessMode(props.showAccessModeControl) ? (
        <>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
          <MenuRadioGroup
            value={props.runtimeMode}
            onValueChange={(value) => {
              if (!value || value === props.runtimeMode) return;
              props.onRuntimeModeChange(value as RuntimeMode);
            }}
          >
            <MenuRadioItem value="approval-required">Supervised</MenuRadioItem>
            <MenuRadioItem value="auto-accept-edits">Auto-accept edits</MenuRadioItem>
            <MenuRadioItem value="auto">Auto</MenuRadioItem>
            <MenuRadioItem value="full-access">Full access</MenuRadioItem>
          </MenuRadioGroup>
        </>
      ) : null}
    </>
  );
}
