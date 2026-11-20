import { errorResponse } from "@/lib/api/response";
import { requireUser } from "@/lib/auth";

// Returns the signed-in user and a Supabase client acting as that user,
// or a 401 response.
//
// Errors are not caught: requireUser() throws when Supabase Auth is
// unreachable (a 500, not a 401), and Next.js uses rejections from
// cookies() to control rendering, so they must reach the framework.
export async function authenticate() {
  return (await requireUser()) ?? errorResponse(401, "Unauthorized");
}
