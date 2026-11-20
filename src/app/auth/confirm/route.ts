import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Registration links only. Password recovery, invites and email changes
// are separate flows.
const confirmationTypes: readonly string[] = ["email", "signup"];

function isConfirmationType(value: string | null): value is EmailOtpType {
  return value !== null && confirmationTypes.includes(value);
}

// Returns `next` only when it stays on this site, so a confirmation link
// cannot send users elsewhere. The URL parser strips tabs and newlines and
// treats "\" as "/", so tricks like "/\evil.com" resolve to another origin.
function safeRedirectPath(next: string | null, origin: string) {
  if (!next?.startsWith("/")) return "/";

  const url = new URL(next, origin);
  return url.origin === origin ? url.pathname + url.search + url.hash : "/";
}

function redirectTo(path: string, origin: string) {
  const response = NextResponse.redirect(new URL(path, origin), 303);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

// Confirms a registration from the email link and starts a cookie-based
// session. The confirmation email template must link here with token_hash
// and type (see README).
export async function GET(request: NextRequest) {
  const { origin, searchParams } = request.nextUrl;
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");

  if (tokenHash && isConfirmationType(type)) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    });

    if (!error) {
      return redirectTo(safeRedirectPath(searchParams.get("next"), origin), origin);
    }
  }

  // Missing, invalid or expired tokens. The token is never logged.
  return redirectTo("/?error=confirmation_failed", origin);
}
