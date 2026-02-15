import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const { userId } = await params;
    const sql = getDb();

    const rows = await sql.query(
      `SELECT id, position, status FROM queue
       WHERE user_id = $1::uuid AND status IN ('waiting', 'active')
       ORDER BY joined_at DESC LIMIT 1`,
      [userId]
    );

    if (!rows.length) {
      return NextResponse.json({ error: "No queue entry found" }, { status: 404 });
    }

    const row = rows[0];
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
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get queue status";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
