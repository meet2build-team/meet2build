import { errorResponse } from "@/lib/api/response";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A media type parameter: token "=" (token or quoted-string), RFC 9110.
const parameterPattern =
  /^([!#$%&'*+.^_`|~0-9a-z-]+)=([!#$%&'*+.^_`|~0-9a-z-]+|"[^"]*")$/i;

const maxEmailLength = 254;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

// A basic syntax check; Supabase Auth and the database validate emails too.
export function isEmailAddress(value: string) {
  return !exceedsLength(value, maxEmailLength) && emailPattern.test(value);
}

// Accepts application/json with optional parameters. JSON is always UTF-8,
// so a charset parameter, when present, must be utf-8.
export function isJsonContentType(header: string | null) {
  const [mediaType, ...parameters] = (header ?? "")
    .split(";")
    .map((part) => part.trim());

  if (mediaType.toLowerCase() !== "application/json") {
    return false;
  }

  return parameters
    .filter((parameter) => parameter !== "")
    .every((parameter) => {
      const match = parameterPattern.exec(parameter);
      if (!match) {
        return false;
      }

      const [, name, value] = match;
      return (
        name.toLowerCase() !== "charset" ||
        value.replace(/^"|"$/g, "").toLowerCase() === "utf-8"
      );
    });
}

// Reads a JSON object request body. Returns a 415 or 400 response when the
// body is not JSON or is not a JSON object.
export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | Response> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return errorResponse(415, "Content-Type must be application/json");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "Request body must be valid JSON");
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse(400, "Request body must be a JSON object");
  }

  return body as Record<string, unknown>;
}

// Counts Unicode characters (code points), as PostgreSQL char_length does.
// A string never has more code points than UTF-16 code units, so short
// strings skip the count.
export function exceedsLength(value: string, maxLength: number) {
  return value.length > maxLength && [...value].length > maxLength;
}
