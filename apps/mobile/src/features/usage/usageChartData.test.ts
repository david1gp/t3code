import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));

import { buildChartDays } from "./usageChartData";

describe("buildChartDays", () => {
  it("plots OpenCode reported costs even though its token totals are zero", () => {
    const days = buildChartDays(
      ["2026-09-24"],
      [
        {
          day: "2026-09-24",
          costUsd: 0.25,
          totalTokens: 0,
          byProvider: new Map([["opencode", { costUsd: 0.25, totalTokens: 0 }]]),
        },
      ],
      "cost",
    );

    expect(days[0]?.values.find((value) => value.provider === "opencode")).toEqual({
      provider: "opencode",
      value: 0.25,
    });
    expect(days[0]?.total).toBe(0.25);
  });
});
