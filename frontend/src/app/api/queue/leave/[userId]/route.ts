import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const { userId } = await params;
    const sql = getDb();

    const rows = await sql.query(
      `UPDATE queue SET status = 'completed'
       WHERE user_id = $1::uuid AND status IN ('waiting', 'active')
       RETURNING id, status`,
      [userId]
    );

    if (!rows.length) {
      return NextResponse.json({ error: "No queue entry found" }, { status: 404 });
    }

    // Auto-advance: promote the next waiting user to active
    await sql.query(
      `UPDATE queue SET status = 'active'
       WHERE id = (
         SELECT id FROM queue
         WHERE status = 'waiting'
         ORDER BY position ASC
         LIMIT 1
       )`
    );

    return NextResponse.json({ status: "left" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to leave queue";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
