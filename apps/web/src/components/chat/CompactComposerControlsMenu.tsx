import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { EllipsisIcon } from "lucide-react";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { CompactComposerControlsMenuContent } from "./CompactComposerControlsMenuContent";
import { getCompactComposerMenuShortcuts } from "./getCompactComposerMenuShortcuts";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  showAccessModeControl: boolean;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  size?: "sm" | "xs";
  /**
   * The resting strip keeps this menu mounted out of flow while every block
   * fits inline. Its portaled popup would outlive that transition, so an
   * open menu closes when its trigger hides.
   */
  hidden?: boolean;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const size = props.size ?? "sm";
  const [open, setOpen] = useComposerMenuState(props.hidden);

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            size={size}
            className="shrink-0"
            aria-label="More composer controls"
            data-composer-shortcut={getCompactComposerMenuShortcuts(
              props.showAccessModeControl,
              Boolean(props.traitsMenuContent),
            )}
          />
        }
      >
        <ComposerControlIcon icon={EllipsisIcon} size={size} />
      </MenuTrigger>
      <MenuPopup align="start" {...composerFloatingLayerProps}>
        <CompactComposerControlsMenuContent
          interactionMode={props.interactionMode}
          runtimeMode={props.runtimeMode}
          showAccessModeControl={props.showAccessModeControl}
          showInteractionModeToggle={props.showInteractionModeToggle}
          traitsMenuContent={props.traitsMenuContent}
          onToggleInteractionMode={props.onToggleInteractionMode}
          onRuntimeModeChange={props.onRuntimeModeChange}
        />
      </MenuPopup>
    </Menu>
  );
});
