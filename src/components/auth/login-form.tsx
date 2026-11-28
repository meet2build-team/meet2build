"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { checkCredentials } from "@/lib/credentials";
import { translateApiError } from "@/lib/error-messages";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSending, setIsSending] = useState(false);

  async function handleSubmit() {
    const trimmedEmail = email.trim();
    const problem = checkCredentials(trimmedEmail, password);
    if (problem) {
      setError(problem);
      return;
    }

    setError("");
    setIsSending(true);

    try {
      const response = await fetch("/api/auth/sign-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmedEmail, password }),
      });

      if (response.ok) {
        router.push("/projects");
        return;
      }

      const body = await response.json().catch(() => null);
      setError(translateApiError(body?.error));
    } catch {
      setError("Няма връзка със сървъра. Опитай пак.");
    }

    setIsSending(false);
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
      className="mt-8 flex flex-col gap-4"
    >
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Имейл
        <input
          type="email"
          name="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="name@example.com"
          className="rounded-lg border border-foreground/20 bg-background px-3 py-2.5 outline-none focus:border-foreground focus:ring-2 focus:ring-foreground/10"
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Парола
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="rounded-lg border border-foreground/20 bg-background px-3 py-2.5 outline-none focus:border-foreground focus:ring-2 focus:ring-foreground/10"
        />
      </label>

      {error !== "" && (
        <p role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={isSending}
        className="mt-2 rounded-lg bg-foreground py-2.5 font-medium text-background transition hover:bg-foreground/85 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSending ? "Влизане..." : "Влез"}
      </button>
    </form>
  );
}