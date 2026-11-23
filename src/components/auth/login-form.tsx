"use client";

import { useState } from "react";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  function handleSubmit() {
    const trimmedEmail = email.trim();

    if (trimmedEmail === "" || password === "") {
      setError("Попълни имейл и парола.");
      return;
    }
    if (!EMAIL_PATTERN.test(trimmedEmail)) {
      setError("Имейлът не е валиден.");
      return;
    }
    if (password.length < 6) {
      setError("Паролата трябва да е поне 6 знака.");
      return;
    }

    setError("");
    // Next step: send the email and password to /api/auth/sign-in.
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
        className="mt-2 rounded-lg bg-foreground py-2.5 font-medium text-background transition hover:bg-foreground/85"
      >
        Влез
      </button>
    </form>
  );
}