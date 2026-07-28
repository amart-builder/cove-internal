"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useState } from "react";

export default function SignIn() {
  const { signIn } = useAuthActions();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await signIn("password", { email, password, flow: mode });
    } catch (err) {
      setError(mode === "signIn" ? "Invalid credentials" : "Could not create account");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <div className="w-full max-w-sm mx-4">
        <div className="text-center mb-8">
          <h1 className="text-xl font-semibold text-foreground">Cove</h1>
          <p className="text-xs text-muted-foreground mt-1">
            {mode === "signIn" ? "Sign in to continue" : "Create your account"}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-[11px] font-medium text-muted-foreground mb-1">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-3 py-2 text-sm border rounded-md outline-none focus:ring-1 focus:ring-accent-blue/40 bg-card text-foreground"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-muted-foreground mb-1">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-3 py-2 text-sm border rounded-md outline-none focus:ring-1 focus:ring-accent-blue/40 bg-card text-foreground"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <p className="text-xs text-accent-red">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 text-sm font-medium bg-foreground text-background rounded-md hover:opacity-90 transition-opacity duration-150 disabled:opacity-50"
          >
            {loading ? "..." : mode === "signIn" ? "Sign In" : "Sign Up"}
          </button>
        </form>

        <p className="text-center text-[11px] text-muted-foreground mt-4">
          {mode === "signIn" ? (
            <>
              No account?{" "}
              <button
                onClick={() => { setMode("signUp"); setError(""); }}
                className="text-accent-blue hover:underline"
              >
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button
                onClick={() => { setMode("signIn"); setError(""); }}
                className="text-accent-blue hover:underline"
              >
                Sign in
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
