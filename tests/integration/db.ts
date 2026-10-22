import { sql } from "kysely";
import { getDb } from "../../packages/core/src/db/index.js";

/**
 * Reset every table except the seeded default playback policy. Tests call this
 * in beforeEach so each one establishes its own state instead of inheriting
 * rows from whichever test ran before it.
 */
export const resetDatabase = async (): Promise<void> => {
  await sql`
    TRUNCATE videos, video_renditions, content_keys, jobs, api_keys, playback_sessions,
             webhook_endpoints, webhook_deliveries, usage_daily
    RESTART IDENTITY CASCADE
  `.execute(getDb());
  // audit_events is append-only by trigger; bypass it only for test resets.
  await sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_truncate`.execute(getDb());
  await sql`TRUNCATE audit_events`.execute(getDb());
  await sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_truncate`.execute(getDb());
  await sql`DELETE FROM playback_policies WHERE NOT is_default`.execute(getDb());
};
