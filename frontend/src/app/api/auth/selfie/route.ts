import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  try {
    const { user_id, selfie_base64 } = await req.json();

    // Strip data-URI prefix if present
    const selfie = selfie_base64.replace(/^data:image\/\w+;base64,/, "");

    const sql = getDb();
    const rows = await sql.query(
      `UPDATE users SET selfie_base64 = $1
       WHERE id = $2::uuid
       RETURNING id, name, email, phone, poke_id`,
      [selfie, user_id]
    );

    if (!rows.length) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    return NextResponse.json(rows[0]);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Selfie upload failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
