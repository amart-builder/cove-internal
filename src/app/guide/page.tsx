import path from "node:path";
import { localDatabasePath } from "@/lib/local/database";
import { getRuntimeMode } from "@/lib/runtime/mode";
import GuidePage from "./content";

// Next prerenders this route at build time by default, which would bake in
// whatever data directory the build ran under -- the same stale-path mistake
// the store fixes in this branch were about. The folder must be read when the
// page is asked for, not when it was compiled.
export const dynamic = "force-dynamic";

// The guide is the only place a person who will never open the repository can
// be told where their work is kept, so it names the real folder this install
// opens rather than a documented default. Resolving it here keeps the copy
// module free of the database import.
export default function Page() {
  const local = getRuntimeMode() === "local";
  return <GuidePage dataFolder={local ? path.dirname(localDatabasePath()) : undefined} />;
}
