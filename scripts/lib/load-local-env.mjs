import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function loadLocalEnv(repoDir, env = process.env) {
  const file = path.join(repoDir, ".env.local");
  if (!existsSync(file)) return env;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    // Next.js reads this same .env.local through dotenv, which accepts a
    // leading `export `. Dropping it here meant one file configured the web
    // app and the workers differently: `export COVE_FOLLOW_THROUGH=0` turned
    // follow-through off on screen while the reminder worker kept sending it.
    // Writing `export` in front of a variable is a normal thing to type, and a
    // setting that is silently honoured in one half of a local-first install
    // is worse than one that is rejected. Note `export=1` still sets `export`:
    // the prefix only counts when whitespace follows it, as in a real shell.
    const line = rawLine.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || Object.hasOwn(env, key)) {
      continue;
    }
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}
