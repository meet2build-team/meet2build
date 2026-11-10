import {
  isAuthApiError,
  isAuthSessionMissingError,
} from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

// Returns the signed-in user and a Supabase client acting as that user,
// or null when the request is not authenticated.
//
// getUser() checks the token with Supabase Auth, so a forged, expired or
// revoked session is rejected. Database queries through the returned client
// run under the user's RLS policies.
export async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error) {
    // No session, or Supabase Auth rejected the token.
    if (isAuthSessionMissingError(error) || isAuthApiError(error)) {
      return null;
    }
    // Supabase Auth is unreachable: report a server error, not a 401.
    throw error;
  }

  return user ? { user, supabase } : null;
}
