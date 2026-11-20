import { isAuthApiError } from "@supabase/supabase-js";
import { readJsonObject } from "@/lib/api/request";
import { errorResponse, internalError, jsonResponse } from "@/lib/api/response";
import { createClient } from "@/lib/supabase/server";

// Signs in with email and password. On success the server client stores the
// session in cookies, where requireUser() reads it on later requests.
export async function POST(request: Request) {
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (email === "" || password === "") {
    return errorResponse(400, "Email and password are required");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (!error) {
    return jsonResponse({ id: data.user.id, email: data.user.email ?? null });
  }

  if (isAuthApiError(error)) {
    switch (error.code) {
      // A wrong password and an unknown email both return this code, so the
      // response never reveals whether an account exists.
      case "invalid_credentials":
        return errorResponse(401, "Invalid email or password");
      // Supabase returns this only after a correct password.
      case "email_not_confirmed":
        return errorResponse(403, "Email address is not confirmed");
      case "over_request_rate_limit":
        return errorResponse(429, "Too many requests");
    }
  }

  // Logs only the error type: the message can contain the email address.
  return internalError("Failed to sign in", {
    name: error.name,
    status: error.status,
    code: error.code,
  });
}
