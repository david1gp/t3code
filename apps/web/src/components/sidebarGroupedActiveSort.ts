import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import { sortThreads, type ThreadSortInput } from "../lib/threadSort";

type ActiveThread = ThreadSortInput & {
  readonly id: string;
  readonly activeOrderKey?: string | null | undefined;
};

/** Sort only automatic active rows; pinned/manual order-key slots stay put. */
export function sidebarGroupedActiveSort<T extends ActiveThread>(
  threads: readonly T[],
  sortOrder: SidebarThreadSortOrder,
): T[] {
  const automatic = sortThreads(
    threads.filter((thread) => thread.activeOrderKey == null),
    sortOrder,
  );
  let nextAutomatic = 0;
  return threads.map((thread) =>
    thread.activeOrderKey == null ? automatic[nextAutomatic++]! : thread,
  );
}
