/** Unknown drivers retain the existing runtime-mode controls. */
export function providerSupportsRuntimeMode(driver: string | undefined): boolean {
  return driver !== "pi";
}
