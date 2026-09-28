// @effect-diagnostics nodeBuiltinImport:off - in-process HTTP protocol fixtures need a real server.
// oxlint-disable t3code/no-manual-effect-runtime-in-tests -- probe tests sequence Effect outcomes with HTTP fixture setup/teardown.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { openCodeProtocolProbe } from "./openCodeProtocolProbe.ts";

type Handler = (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => void;

async function fixture(handler: Handler) {
  const server = NodeHttp.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const info = (version = "2.0.18") => ({
  version,
  pid: 23,
  urls: ["http://127.0.0.1"],
  paths: { tmp: "/tmp" },
});

describe("per-instance OpenCode protocol probe", () => {
  it("selects native v2.0.18 using authenticated GET /api/info", async () => {
    const calls: string[] = [];
    const server = await fixture((req, res) => {
      calls.push(`${req.method} ${req.url}`);
      expect(req.headers.authorization).toBe(
        `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
      );
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(info()));
    });
    try {
      expect(
        await Effect.runPromise(
          openCodeProtocolProbe({ url: server.url, directory: "/tmp", serverPassword: "secret" }),
        ),
      ).toEqual({ protocol: "native", version: "2.0.18" });
      expect(calls).toEqual(["GET /api/info"]);
    } finally {
      await server.close();
    }
  });

  for (const [label, status, type] of [
    ["missing route", 404, "application/json"],
    ["HTML response", 200, "text/html"],
  ] as const) {
    it(`uses the existing legacy health check only for ${label}`, async () => {
      const calls: string[] = [];
      const server = await fixture((req, res) => {
        calls.push(req.url ?? "");
        expect(req.headers.authorization).toBe(
          `Basic ${Buffer.from("opencode:legacy").toString("base64")}`,
        );
        if (req.url?.startsWith("/api/info")) {
          res.writeHead(status, { "Content-Type": type });
          res.end(type === "text/html" ? "<html>old</html>" : "{}");
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ healthy: true, version: "1.18.32" }));
      });
      try {
        expect(
          await Effect.runPromise(
            openCodeProtocolProbe({ url: server.url, directory: "/tmp", serverPassword: "legacy" }),
          ),
        ).toEqual({ protocol: "legacy", version: "1.18.32" });
        expect(calls).toEqual(["/api/info", "/global/health?directory=%2Ftmp"]);
      } finally {
        await server.close();
      }
    });
  }

  for (const status of [401, 403, 500, 503, 302]) {
    it(`fails closed on HTTP ${status} without consulting legacy health`, async () => {
      const calls: string[] = [];
      const server = await fixture((req, res) => {
        calls.push(req.url ?? "");
        res.writeHead(status, { "Content-Type": "text/html", Location: "/login" });
        res.end("<html>error</html>");
      });
      try {
        const result = await Effect.runPromise(
          openCodeProtocolProbe({
            url: server.url,
            directory: "/tmp",
            serverPassword: "wrong",
          }).pipe(Effect.result),
        );
        expect(result._tag).toBe("Failure");
        expect(calls).toEqual(["/api/info"]);
      } finally {
        await server.close();
      }
    });
  }

  it("fails closed on invalid info, unsupported version and connection failure", async () => {
    const server = await fixture((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(info("1.18.32")));
    });
    try {
      const result = await Effect.runPromise(
        openCodeProtocolProbe({ url: server.url, directory: "/tmp" }).pipe(Effect.result),
      );
      expect(result._tag).toBe("Failure");
    } finally {
      await server.close();
    }
    const network = await Effect.runPromise(
      openCodeProtocolProbe({ url: server.url, directory: "/tmp" }).pipe(Effect.result),
    );
    expect(network._tag).toBe("Failure");
  });

  it("does not accept malformed native JSON or downgrade when legacy health rejects credentials", async () => {
    const calls: string[] = [];
    const server = await fixture((req, res) => {
      calls.push(req.url ?? "");
      if (req.url === "/api/info") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end('{"message":"Unauthorized"}');
    });
    try {
      const result = await Effect.runPromise(
        openCodeProtocolProbe({ url: server.url, directory: "/tmp", serverPassword: "wrong" }).pipe(
          Effect.result,
        ),
      );
      expect(result._tag).toBe("Failure");
      expect(calls).toEqual(["/api/info", "/global/health?directory=%2Ftmp"]);
    } finally {
      await server.close();
    }
    const malformed = await fixture((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end('{"healthy":true,"version":"2.0.18"}');
    });
    try {
      const result = await Effect.runPromise(
        openCodeProtocolProbe({ url: malformed.url, directory: "/tmp" }).pipe(Effect.result),
      );
      expect(result._tag).toBe("Failure");
    } finally {
      await malformed.close();
    }
  });

  it("does not share protocol or credentials between two simultaneous instances", async () => {
    const v2 = await fixture((req, res) => {
      expect(req.headers.authorization).toBe(
        `Basic ${Buffer.from("opencode:v2-secret").toString("base64")}`,
      );
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(info()));
    });
    const v1 = await fixture((req, res) => {
      expect(req.headers.authorization).toBe(
        `Basic ${Buffer.from("opencode:v1-secret").toString("base64")}`,
      );
      res.setHeader("Content-Type", "application/json");
      res.writeHead(req.url === "/api/info" ? 404 : 200);
      res.end(JSON.stringify({ healthy: true, version: "1.18.32" }));
    });
    try {
      const [native, legacy] = await Promise.all([
        Effect.runPromise(
          openCodeProtocolProbe({ url: v2.url, directory: "/tmp", serverPassword: "v2-secret" }),
        ),
        Effect.runPromise(
          openCodeProtocolProbe({ url: v1.url, directory: "/tmp", serverPassword: "v1-secret" }),
        ),
      ]);
      expect(native.protocol).toBe("native");
      expect(legacy.protocol).toBe("legacy");
    } finally {
      await Promise.all([v1.close(), v2.close()]);
    }
  });
});
