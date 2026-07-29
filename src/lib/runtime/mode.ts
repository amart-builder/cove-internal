export type RuntimeMode = "convex" | "supabase" | "local";

export function getRuntimeMode(): RuntimeMode {
  const mode =
    process.env.NEXT_PUBLIC_COVE_RUNTIME ??
    process.env.NEXT_PUBLIC_FORGE_RUNTIME;
  if (mode === "supabase") return "supabase";
  if (mode === "convex") return "convex";
  // Default: fully local SQLite. No account and no login required.
  return "local";
}
