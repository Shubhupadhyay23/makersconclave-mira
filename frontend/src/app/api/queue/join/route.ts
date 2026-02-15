import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  try {
    const { user_id } = await req.json();
    const sql = getDb();

    // Check if user already has a waiting/active queue entry
    const existing = await sql.query(
      `SELECT id, position, status FROM queue
       WHERE user_id = $1::uuid AND status IN ('waiting', 'active')`,
      [user_id]
    );

    if (existing.length) {
      const row = existing[0];
      const countRows = await sql.query(
        `SELECT COUNT(*)::int AS cnt FROM queue
         WHERE status = 'waiting' AND position < $1`,
        [row.position]
      );
      return NextResponse.json({
        queue_id: row.id,
        position: row.position,
        status: row.status,
        total_ahead: countRows[0].cnt,
      });
    }

    // Calculate next position
    const maxRows = await sql.query(
      `SELECT COALESCE(MAX(position), 0)::int AS max_pos
       FROM queue WHERE status IN ('waiting', 'active')`
    );
    const nextPosition = maxRows[0].max_pos + 1;

    // Insert new queue entry
    const inserted = await sql.query(
      `INSERT INTO queue (user_id, position)
       VALUES ($1::uuid, $2)
       ON CONFLICT (user_id) WHERE status IN ('waiting', 'active') DO NOTHING
       RETURNING id, position, status`,
      [user_id, nextPosition]
    );

    if (!inserted.length) {
      // Race condition: fetch the existing entry
      const raceCheck = await sql.query(
        `SELECT id, position, status FROM queue
         WHERE user_id = $1::uuid AND status IN ('waiting', 'active')`,
        [user_id]
      );
      if (raceCheck.length) {
        return NextResponse.json({
          queue_id: raceCheck[0].id,
          position: raceCheck[0].position,
          status: raceCheck[0].status,
          total_ahead: 0,
        });
      }
      return NextResponse.json({ error: "Failed to join queue" }, { status: 500 });
    }

    const row = inserted[0];

    const countRows = await sql.query(
      `SELECT COUNT(*)::int AS cnt FROM queue
       WHERE status = 'waiting' AND position < $1`,
      [row.position]
    );

    // Auto-activate if no one is currently active
    const activeRows = await sql.query(
      `SELECT COUNT(*)::int AS cnt FROM queue WHERE status = 'active'`
    );

    if (activeRows[0].cnt === 0) {
      const activated = await sql.query(
        `UPDATE queue SET status = 'active'
         WHERE id = (
           SELECT id FROM queue
           WHERE status = 'waiting'
           ORDER BY position ASC
           LIMIT 1
         )
         RETURNING id`
      );
      if (activated.length && String(activated[0].id) === String(row.id)) {
        row.status = "active";
      }
    }

    return NextResponse.json({
      queue_id: row.id,
      position: row.position,
      status: row.status,
      total_ahead: countRows[0].cnt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to join queue";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
