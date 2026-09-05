import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Local pages can still be embedded by another website. Block framing so
  // an overlay cannot trick the operator into clicking Cove controls.
  headers: async () => [{
    source: "/:path*",
    headers: [
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "same-origin" },
    ],
  }],
  // better-sqlite3 is a native module; keep it out of the bundler.
  serverExternalPackages: ["better-sqlite3"],
  // Pin the workspace root to this repo. Without this, Next walks up to the
  // outermost lockfile it finds (a stray package-lock.json in the user's home
  // directory counts) and then scans/watches that whole tree: broken module
  // resolution plus a runaway memory spiral in dev.
  turbopack: { root: __dirname },
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
