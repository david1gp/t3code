import { Event, EventLog, Form, Location, Permission, Session } from "@opencode/client/effect";
import * as Schema from "effect/Schema";

// These are different contracts: internal usage/replay events are legal only in
// the durable log, while deltas, progress and interactive requests are live-only.
// toEncoded keeps replay content timestamps on the wire, not DateTime objects.
// Non-execution feed variants (session.status/session.idle and inventory,
// configuration, filesystem, PTY, TUI or plugin RPC notifications) are
// intentionally ignored by this session engine. The
// native client continues to expose those through its complete V2Event type.
export const openCodeNativeWireSchema = {
  session: Schema.toEncoded(Session.Event.All),
  feed: Schema.toEncoded(
    Schema.Union([
      ...Session.Event.Definitions,
      ...Permission.Event.Definitions,
      ...Form.Event.Definitions,
      Schema.Struct({
        id: Event.ID,
        metadata: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
        location: Schema.optionalKey(Location.PublicRef),
        type: Schema.Literal("server.connected"),
        data: Schema.Struct({}),
      }),
    ]),
  ),
  log: Schema.toEncoded(Schema.Union([Session.Event.Durable, EventLog.Synced])),
};
