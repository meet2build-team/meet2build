import { describe, expect, it } from "vitest";
import {
  exceedsLength,
  isEmailAddress,
  isJsonContentType,
  isUuid,
  readJsonObject,
} from "@/lib/api/request";

function post(body: string, contentType?: string) {
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: contentType ? { "Content-Type": contentType } : undefined,
    body,
  });
}

describe("isUuid", () => {
  it("accepts UUIDs in any letter case", () => {
    expect(isUuid("0b9c2b0e-4f1a-4c3e-9d2a-7f6e5d4c3b2a")).toBe(true);
    expect(isUuid("0B9C2B0E-4F1A-4C3E-9D2A-7F6E5D4C3B2A")).toBe(true);
  });

  it("rejects other values", () => {
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("0b9c2b0e-4f1a-4c3e-9d2a-7f6e5d4c3b2")).toBe(false);
    expect(isUuid(" 0b9c2b0e-4f1a-4c3e-9d2a-7f6e5d4c3b2a")).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});

describe("isEmailAddress", () => {
  it("accepts addresses with a domain", () => {
    expect(isEmailAddress("user@example.com")).toBe(true);
    expect(isEmailAddress("first.last+tag@sub.example.org")).toBe(true);
  });

  it("rejects malformed or overlong addresses", () => {
    expect(isEmailAddress("")).toBe(false);
    expect(isEmailAddress("user")).toBe(false);
    expect(isEmailAddress("user@localhost")).toBe(false);
    expect(isEmailAddress("a b@example.com")).toBe(false);
    expect(isEmailAddress("a@b@example.com")).toBe(false);
    // 254 characters is the limit.
    expect(isEmailAddress(`${"a".repeat(242)}@example.com`)).toBe(true);
    expect(isEmailAddress(`${"a".repeat(243)}@example.com`)).toBe(false);
  });
});

describe("isJsonContentType", () => {
  it.each([
    "application/json",
    "Application/JSON",
    "application/json; charset=utf-8",
    "application/json;charset=UTF-8",
    'application/json; charset="utf-8"',
    "application/json;",
  ])("accepts %s", (header) => {
    expect(isJsonContentType(header)).toBe(true);
  });

  it.each([
    null,
    "",
    "text/plain",
    "text/plain;charset=UTF-8",
    "application/jsonp",
    "application/json-patch+json",
    "application/json; charset=iso-8859-1",
    "application/json; charset",
    "application/json; =utf-8",
  ])("rejects %s", (header) => {
    expect(isJsonContentType(header)).toBe(false);
  });
});

describe("readJsonObject", () => {
  it("returns the parsed object", async () => {
    const body = await readJsonObject(
      post('{"name":"Demo"}', "application/json; charset=utf-8"),
    );
    expect(body).toEqual({ name: "Demo" });
  });

  it("returns 415 for a non-JSON content type", async () => {
    // A string body without headers is sent as text/plain;charset=UTF-8.
    const response = await readJsonObject(post('{"name":"Demo"}'));
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(415);
  });

  it("returns 400 for malformed JSON", async () => {
    const response = (await readJsonObject(
      post("{", "application/json"),
    )) as Response;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Request body must be valid JSON",
    });
  });

  it.each(["null", "[]", '"text"', "42", "true"])(
    "returns 400 for the non-object body %s",
    async (json) => {
      const response = (await readJsonObject(
        post(json, "application/json"),
      )) as Response;
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Request body must be a JSON object",
      });
    },
  );
});

describe("exceedsLength", () => {
  it("allows strings up to the limit", () => {
    expect(exceedsLength("a".repeat(255), 255)).toBe(false);
    expect(exceedsLength("a".repeat(256), 255)).toBe(true);
  });

  it("counts characters, not UTF-16 code units", () => {
    // Each emoji is one character but two UTF-16 code units.
    expect(exceedsLength("😀".repeat(255), 255)).toBe(false);
    expect(exceedsLength("😀".repeat(256), 255)).toBe(true);
    expect(exceedsLength("я".repeat(255), 255)).toBe(false);
  });
});
