import path from "node:path";
import { localDatabasePath } from "@/lib/local/database";
import { getRuntimeMode } from "@/lib/runtime/mode";
import GuidePage from "./content";

// The guide is the only place a person who will never open the repository can
// be told where their work is kept, so it names the real folder this install
// opens rather than a documented default. Resolving it here keeps the copy
// module free of the database import.
export default function Page() {
  const local = getRuntimeMode() === "local";
  return <GuidePage dataFolder={local ? path.dirname(localDatabasePath()) : undefined} />;
}
