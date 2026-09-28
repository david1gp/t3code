import { describe, expect, it } from "vite-plus/test";

import { openCodeNativeClientCreate } from "./openCodeNativeClientCreate.ts";

describe("openCodeNativeClientCreate", () => {
  it("creates the official typed client with the configured URL and Basic auth", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = openCodeNativeClientCreate({
      url: "https://opencode.example/base",
      serverPassword: "päss:🔒",
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return Response.json({ version: "2.0.18", pid: 123, urls: [], paths: { tmp: "/tmp" } });
      },
    });

    await expect(client.server.info()).resolves.toEqual({
      version: "2.0.18",
      pid: 123,
      urls: [],
      paths: { tmp: "/tmp" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://opencode.example/base/api/info");
    expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe(
      `Basic ${Buffer.from("opencode:päss:🔒", "utf8").toString("base64")}`,
    );
  });

  it("does not add authorization when no password is configured", async () => {
    let authorization: string | null = null;
    const client = openCodeNativeClientCreate({
      url: "https://opencode.example",
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get("Authorization");
        return Response.json({ version: "2.0.18", pid: 123, urls: [], paths: { tmp: "/tmp" } });
      },
    });

    await client.server.info();
    expect(authorization).toBeNull();
  });
});
