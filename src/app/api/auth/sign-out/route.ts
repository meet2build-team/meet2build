import { isAuthApiError } from "@supabase/supabase-js";
import { internalError, jsonResponse } from "@/lib/api/response";
import { createClient } from "@/lib/supabase/server";

// Signs out the current session only; other devices stay signed in. It works
// without a valid session, so calling it again also succeeds.
export async function POST() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut({ scope: "local" });

  // With the local scope, the session cookies are cleared before Supabase is
  // asked to revoke the session. A 4xx error means the session had already
  // expired or been revoked, so the user is signed out either way. Any other
  // error means Supabase could not confirm the revocation.
  if (error && !(isAuthApiError(error) && error.status < 500)) {
    return internalError("Failed to sign out", {
      name: error.name,
      status: error.status,
      code: error.code,
    });
  }

  return jsonResponse({ message: "Signed out" });
}
