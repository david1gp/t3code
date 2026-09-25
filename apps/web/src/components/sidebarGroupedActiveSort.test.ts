import { describe, expect, it } from "vite-plus/test";
import { sidebarGroupedActiveSort } from "./sidebarGroupedActiveSort";

const thread = (
  id: string,
  createdAt: string,
  updatedAt: string,
  activeOrderKey: string | null = null,
) => ({ id, title: id, createdAt, updatedAt, activeOrderKey }) as const;

describe("sidebarGroupedActiveSort", () => {
  it("sorts automatic active rows by preference without moving explicit manual slots", () => {
    const threads = [
      thread("old", "2025-01-01", "2025-02-01"),
      thread("manual", "2024-01-01", "2024-01-01", "a"),
      thread("new", "2025-02-01", "2025-01-01"),
    ];

    expect(sidebarGroupedActiveSort(threads, "created_at").map(({ id }) => id)).toEqual([
      "new",
      "manual",
      "old",
    ]);
    expect(sidebarGroupedActiveSort(threads, "updated_at").map(({ id }) => id)).toEqual([
      "old",
      "manual",
      "new",
    ]);
  });
});
