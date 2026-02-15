import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  try {
    const { user_id, name, phone } = await req.json();
    const sql = getDb();

    let rows;
    if (phone !== undefined) {
      rows = await sql.query(
        `UPDATE users SET name = $1, phone = $2
         WHERE id = $3::uuid
         RETURNING id, name, email, phone, poke_id`,
        [name, phone, user_id]
      );
    } else {
      rows = await sql.query(
        `UPDATE users SET name = $1
         WHERE id = $2::uuid
         RETURNING id, name, email, phone, poke_id`,
        [name, user_id]
      );
    }

    if (!rows.length) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    return NextResponse.json(rows[0]);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Profile update failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
