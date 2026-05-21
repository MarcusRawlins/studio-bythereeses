import { saveGoogleCalendarConnection } from "@/lib/google-calendar";
import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3000/api/google/callback";

  if (!code) {
    return NextResponse.json({ error: "No OAuth code provided." }, { status: 400 });
  }
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required." }, { status: 400 });
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    return NextResponse.json({ error: "Failed to exchange Google OAuth code." }, { status: 500 });
  }

  const tokens = await response.json() as { refresh_token?: string; scope?: string };
  if (!tokens.refresh_token) {
    return NextResponse.json({
      error: "No refresh token returned. Reconnect with Google consent or remove existing app access in Google Account permissions and try again.",
    }, { status: 400 });
  }

  await saveGoogleCalendarConnection(tokens.refresh_token, tokens.scope);
  revalidatePath("/scheduler");

  return NextResponse.redirect(new URL("/scheduler?google=connected", request.url), 303);
}
