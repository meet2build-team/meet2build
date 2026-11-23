import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/login-form";

export const metadata: Metadata = {
  title: "Вход | Meet2Build",
};

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-foreground/5 px-4 font-sans">
      <div className="w-full max-w-sm rounded-2xl border border-foreground/10 bg-background p-8 shadow-lg">
        <h1 className="text-2xl font-bold">Вход</h1>
        <p className="mt-1 text-sm text-foreground/60">Влез в профила си в Meet2Build</p>

        <LoginForm />
      </div>
    </main>
  );
}