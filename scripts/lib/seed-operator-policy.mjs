import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coveConfigPath, coveConfigWritePath } from "../../src/lib/env-runtime.mjs";

/** The bare name; coveConfigPath turns it into cove-policy.md, or the legacy forge- twin. */
export const POLICY_NAME = "policy.md";
export const TEMPLATE_RELATIVE = path.join("prompts", "operator-policy.template.md");

/**
 * Put the operator policy where the lanes look for it.
 *
 * Six lanes open `readOperatorPolicy` and put the result at the top of their
 * prompt, and the template is the only statement anywhere in the repository of
 * the rule against creating work that is already on the board. Nothing ever
 * created the file, so on every install that rule reached no model at all and a
 * commitment arriving twice got two cards.
 *
 * An operator's own policy is never overwritten, under either spelling of the
 * name -- this only fills an absence.
 */
export function seedOperatorPolicy({ dataDir, repoDir }) {
  if (!dataDir) throw new Error("seedOperatorPolicy needs the data directory this install uses.");
  if (!repoDir) throw new Error("seedOperatorPolicy needs the repository directory to read the template from.");

  // Resolves the legacy forge-policy.md too, so an older install that already
  // has one keeps it rather than gaining a second, unread file beside it.
  const existing = coveConfigPath(dataDir, POLICY_NAME);
  if (existsSync(existing)) return { created: false, path: existing };

  const template = path.join(repoDir, TEMPLATE_RELATIVE);
  const text = readFileSync(template, "utf8");
  if (!text.trim()) throw new Error(`The operator policy template at ${template} is empty.`);

  const target = coveConfigWritePath(dataDir, POLICY_NAME);
  mkdirSync(path.dirname(target), { recursive: true });
  // Everything else Cove writes into the data directory is 0600, and this file
  // is the operator's own standing instructions once they edit it.
  writeFileSync(target, text, { mode: 0o600 });
  chmodSync(target, 0o600);
  return { created: true, path: target };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dataDir, repoDir] = process.argv.slice(2);
  const result = seedOperatorPolicy({ dataDir, repoDir });
  process.stdout.write(
    result.created
      ? `Wrote the starting operator policy to ${result.path}\n`
      : `Kept the operator policy already at ${result.path}\n`,
  );
}
