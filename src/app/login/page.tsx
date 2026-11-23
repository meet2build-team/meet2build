export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-foreground/5 px-4 font-sans">
      <div className="w-full max-w-sm rounded-2xl border border-foreground/10 bg-background p-8 shadow-lg">
        <h1 className="text-2xl font-bold">Вход</h1>
        <p className="mt-1 text-sm text-foreground/60">Влез в профила си в Meet2Build</p>

        <form className="mt-8 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Имейл
            <input
              type="email"
              name="email"
              placeholder="name@example.com"
              className="rounded-lg border border-foreground/20 bg-background px-3 py-2.5 outline-none focus:border-foreground focus:ring-2 focus:ring-foreground/10"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Парола
            <input
              type="password"
              name="password"
              className="rounded-lg border border-foreground/20 bg-background px-3 py-2.5 outline-none focus:border-foreground focus:ring-2 focus:ring-foreground/10"
            />
          </label>
          <button
            type="submit"
            className="mt-2 rounded-lg bg-foreground py-2.5 font-medium text-background transition hover:bg-foreground/85"
          >
            Влез
          </button>
        </form>
      </div>
    </main>
  );
}