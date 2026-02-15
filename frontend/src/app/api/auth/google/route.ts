import { NextRequest, NextResponse } from "next/server";
import { OAuth2Client } from "google-auth-library";
import { getDb } from "@/lib/db";

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID!;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;

export async function POST(req: NextRequest) {
  try {
    const { code, redirect_uri = "postmessage" } = await req.json();

    // Exchange auth code for tokens
    const client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, redirect_uri);
    const { tokens } = await client.getToken(code);

    // Verify the ID token to extract user info
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token!,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload()!;
    const email = payload.email!;
    const name = payload.name || email;

    // Store token data for Gmail scraping later
    const oauthJson = JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      id_token: tokens.id_token,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      token_uri: "https://oauth2.googleapis.com/token",
    });

    // Upsert user
    const sql = getDb();
    const rows = await sql.query(
      `INSERT INTO users (name, email, google_oauth_token)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (email) DO UPDATE
         SET name = EXCLUDED.name,
             google_oauth_token = EXCLUDED.google_oauth_token
       RETURNING id, name, email, phone, poke_id`,
      [name, email, oauthJson]
    );

    return NextResponse.json(rows[0]);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Google auth failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
