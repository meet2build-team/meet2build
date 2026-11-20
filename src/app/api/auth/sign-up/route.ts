import { isAuthApiError } from "@supabase/supabase-js";
import { exceedsLength, readJsonObject } from "@/lib/api/request";
import { errorResponse, internalError, jsonResponse } from "@/lib/api/response";
import { createClient } from "@/lib/supabase/server";

// Matches minimum_password_length in supabase/config.toml. Supabase Auth
// enforces its own setting as well.
const minPasswordLength = 6;
const maxEmailLength = 254;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// New and already registered emails get the same response, so the API never
// reveals whether an account exists.
function accepted() {
  return jsonResponse({ message: "Registration received" }, 202);
}

// Registers a user with Supabase Auth. When email confirmation is disabled,
// Supabase returns a session and the server client stores it in cookies.
// When it is enabled, Supabase sends a confirmation email instead.
export async function POST(request: Request) {
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (email === "" || password === "") {
    return errorResponse(400, "Email and password are required");
  }
  if (exceedsLength(email, maxEmailLength) || !emailPattern.test(email)) {
    return errorResponse(400, "Invalid email address");
  }
  if ([...password].length < minPasswordLength) {
    return errorResponse(
      400,
      `Password must be at least ${minPasswordLength} characters`,
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({ email, password });

  if (!error) return accepted();

  if (isAuthApiError(error)) {
    switch (error.code) {
      // Returned only when email confirmation is disabled.
      case "user_already_exists":
      case "email_exists":
        return accepted();
      case "weak_password":
        return errorResponse(400, "Password does not meet the requirements");
      case "email_address_invalid":
        return errorResponse(400, "Invalid email address");
      case "validation_failed":
        return errorResponse(400, "Invalid email or password");
      case "signup_disabled":
      case "email_provider_disabled":
        return errorResponse(403, "Registration is disabled");
      case "over_request_rate_limit":
      case "over_email_send_rate_limit":
        return errorResponse(429, "Too many requests");
    }
  }

  // Logs only the error type: the message can contain the email address.
  return internalError("Failed to register user", {
    name: error.name,
    status: error.status,
    code: error.code,
  });
}
