import { describe, expect, it } from "vite-plus/test";
import { sidebarGroupedActiveSort } from "./sidebarGroupedActiveSort";

const thread = (
  id: string,
  createdAt: string,
  updatedAt: string,
  activeOrderKey: string | null = null,
  latestUserMessageAt: string | null = null,
) =>
  ({
    id,
    title: id,
    createdAt,
    updatedAt,
    latestUserMessageAt,
    messages: [{ role: "user", createdAt: latestUserMessageAt ?? updatedAt }],
    activeOrderKey,
  }) as const;

describe("sidebarGroupedActiveSort", () => {
  it("keeps unkeyed order stable when user-message and activity timestamps change", () => {
    const threads = [
      thread("older", "2025-01-01", "2025-02-01", null, "2025-02-01"),
      thread("newer", "2025-02-01", "2025-01-01", null, "2025-01-01"),
    ];

    const updatedActivity = threads.map((value) => ({
      ...value,
      updatedAt: value.id === "older" ? "2026-01-01" : "2024-01-01",
      latestUserMessageAt: value.id === "older" ? "2026-01-01" : "2024-01-01",
      messages: [{ role: "user", createdAt: value.id === "older" ? "2026-01-01" : "2024-01-01" }],
    }));

    expect(sidebarGroupedActiveSort(threads).map(({ id }) => id)).toEqual(["newer", "older"]);
    expect(sidebarGroupedActiveSort(updatedActivity).map(({ id }) => id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("orders manually keyed rows by their canonical keys, ahead of unkeyed rows", () => {
    const threads = [
      thread("key-z", "2025-01-01", "2025-01-01", "z"),
      thread("automatic", "2025-03-01", "2025-03-01"),
      thread("key-a", "2025-02-01", "2025-02-01", "a"),
    ];

    expect(sidebarGroupedActiveSort(threads).map(({ id }) => id)).toEqual([
      "automatic",
      "key-a",
      "key-z",
    ]);
  });
});
