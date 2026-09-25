import { describe, expect, it } from "vite-plus/test";
import { sidebarGroupedThreadPreview } from "./sidebarGroupedThreadPreview";

describe("sidebarGroupedThreadPreview", () => {
  it("limits grouped non-settled rows and reveals or hides the rest on demand", () => {
    const input = { pinned: ["pinned"], active: ["active-1", "active-2"], snoozed: ["snoozed"] };
    expect(sidebarGroupedThreadPreview({ ...input, limit: 2, expanded: false })).toEqual({
      pinned: ["pinned"],
      active: ["active-1"],
      snoozed: [],
      hasMore: true,
    });
    expect(sidebarGroupedThreadPreview({ ...input, limit: 2, expanded: true })).toEqual({
      ...input,
      hasMore: true,
    });
    expect(sidebarGroupedThreadPreview({ ...input, limit: 4, expanded: false }).hasMore).toBe(
      false,
    );
  });

  it("shows the earliest snoozed rows when active rows leave preview space", () => {
    expect(
      sidebarGroupedThreadPreview({
        pinned: ["pinned"],
        active: ["active"],
        snoozed: ["soon", "later", "latest"],
        limit: 3,
        expanded: false,
      }),
    ).toEqual({
      pinned: ["pinned"],
      active: ["active"],
      snoozed: ["soon"],
      hasMore: true,
    });
  });
});
