import { sql } from "kysely";
import { getDb, type Row, type Trx } from "@evs/core/db";

export type UsageRow = Row<"usage_daily">;

export type UsageCounter = "videos_created" | "playback_sessions" | "key_deliveries";

class UsageRepository {
  /** Atomic upsert-increment of today's row. */
  async increment(counter: UsageCounter, by: number, trx?: Trx): Promise<void> {
    if (by <= 0) return;
    const col = sql.ref(counter);
    await sql`
      INSERT INTO usage_daily (day, ${col}) VALUES (current_date, ${by})
      ON CONFLICT (day) DO UPDATE SET ${col} = usage_daily.${col} + EXCLUDED.${col}, updated_at = now()
    `.execute(trx || getDb());
  }

  /**
   * Days in [from, to] inclusive. `day` is read back as text: a pg DATE parsed
   * into a JS Date becomes local midnight, which shifts a day on any non-UTC
   * host. A string is exact.
   */
  async range(
    from: string,
    to: string
  ): Promise<Array<Omit<UsageRow, "day" | "updated_at" | "transcode_seconds"> & { day: string; transcode_seconds: string }>> {
    const res = await sql<
      Omit<UsageRow, "day" | "updated_at" | "transcode_seconds"> & { day: string; transcode_seconds: string }
    >`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, videos_created, transcode_seconds::text AS transcode_seconds,
             playback_sessions, key_deliveries
      FROM usage_daily
      WHERE day BETWEEN ${from}::date AND ${to}::date
      ORDER BY day ASC
    `.execute(getDb());
    return res.rows;
  }
}

export default new UsageRepository();
