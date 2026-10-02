import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));

import { buildChartDays } from "./usageChartData";
import { PROVIDER_LABEL, PROVIDER_ORDER, useProviderColors } from "./usageProviders";

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

  it("projects Pi's reported cost with its provider identity and zero token series", () => {
    const [day] = buildChartDays(
      ["2026-10-01"],
      [
        {
          day: "2026-10-01",
          costUsd: 1.25,
          totalTokens: 0,
          byProvider: new Map([["pi", { costUsd: 1.25, totalTokens: 0 }]]),
        },
      ],
      "cost",
    );

    expect(PROVIDER_LABEL.pi).toBe("Pi");
    expect(PROVIDER_ORDER.at(-1)).toBe("pi");
    expect(useProviderColors().pi).toBe("#6b7280");
    expect(day?.values.find((value) => value.provider === "pi")).toEqual({
      provider: "pi",
      value: 1.25,
    });
    expect(day?.total).toBe(1.25);
  });
});
