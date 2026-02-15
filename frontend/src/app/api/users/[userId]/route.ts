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
      `SELECT id, name, email, phone, poke_id FROM users WHERE id = $1::uuid`,
      [userId]
    );

    if (!rows.length) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    return NextResponse.json(rows[0]);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to get user";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
