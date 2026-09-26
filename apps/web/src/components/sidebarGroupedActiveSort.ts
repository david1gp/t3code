import { sortActiveThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";

type ActiveThread = {
  readonly id: string;
  readonly createdAt: string;
  readonly unsettledAt?: string | null | undefined;
  readonly environmentId?: string | undefined;
  readonly activeOrderKey?: string | null | undefined;
};

/** Grouped active rows use the shared stable creation/manual-key order, never message activity. */
export function sidebarGroupedActiveSort<T extends ActiveThread>(threads: readonly T[]): T[] {
  return sortActiveThreadsByOrderKey(threads);
}
