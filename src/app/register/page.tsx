import type { Metadata } from "next";
import { RegisterForm } from "@/components/auth/register-form";

export const metadata: Metadata = {
  title: "Регистрация | Meet2Build",
};

export default function RegisterPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-foreground/5 px-4 font-sans">
      <div className="w-full max-w-sm rounded-2xl border border-foreground/10 bg-background p-8 shadow-lg">
        <h1 className="text-2xl font-bold">Регистрация</h1>
        <p className="mt-1 text-sm text-foreground/60">Създай профил в Meet2Build</p>

        <RegisterForm />
      </div>
    </main>
  );
}