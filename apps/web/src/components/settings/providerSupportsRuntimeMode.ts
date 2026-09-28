import type { ProviderDriverKind } from "@t3tools/contracts";
import { getDriverOption } from "./providerDriverMeta";

/** Unknown/fork drivers retain the existing runtime-mode controls. */
export function providerSupportsRuntimeMode(driver: ProviderDriverKind | undefined): boolean {
  return getDriverOption(driver)?.supportsRuntimeMode !== false;
}
