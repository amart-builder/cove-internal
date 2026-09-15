import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NODE_PLACEHOLDER = "__COVE_NODE_REAL__";
const JOB_RUNNER_PLACEHOLDER = "__COVE_JOB_RUNNER__";
const CODEX_PLACEHOLDER = "__COVE_CODEX_BIN__";
const NOTIFICATION_APP_PLACEHOLDER = "__COVE_NOTIFICATION_APP__";

export function renderLanePlist({
  source,
  destination,
  repoDir,
  homeDir,
  atlasRoot,
  dataDir,
  nodePath,
  jobRunner = "codex-sol-high",
  codexPath = "",
  notificationApp = "",
  webBase = "http://127.0.0.1:3200",
  dbPath = path.join(dataDir, "cove.db"),
}) {
  const template = fs.readFileSync(source, "utf8");
  const templateRepo = template.match(
    /<string>([^<]*\/Atlas\/Projects\/astack\/cove)(?:\/[^<]*)?<\/string>/,
  )?.[1];
  if (!templateRepo) throw new Error(`Could not locate the repo path in ${source}`);
  if (!template.includes(NODE_PLACEHOLDER)) {
    throw new Error(`Could not locate ${NODE_PLACEHOLDER} in ${source}`);
  }

  const templateAtlas = path.resolve(templateRepo, "../../..");
  const templateHome = path.dirname(templateAtlas);
  const templateData = path.join(templateRepo, "data");
  const xml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const rendered = template
    .replaceAll(templateData, xml(dataDir))
    .replaceAll(templateRepo, xml(repoDir))
    .replaceAll(templateAtlas, xml(atlasRoot))
    .replaceAll(templateHome, xml(homeDir))
    .replaceAll(NODE_PLACEHOLDER, xml(nodePath))
    .replaceAll(JOB_RUNNER_PLACEHOLDER, xml(jobRunner))
    .replaceAll(CODEX_PLACEHOLDER, xml(codexPath))
    .replaceAll(NOTIFICATION_APP_PLACEHOLDER, xml(notificationApp))
    .replaceAll("__COVE_BRIEF_WEB_BASE__", xml(webBase))
    .replaceAll("__COVE_DB_PATH__", xml(dbPath));

  fs.writeFileSync(destination, rendered, { mode: 0o600 });
  return rendered;
}

const moduleUrl = pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href;
const invokedUrl = process.argv[1]
  ? pathToFileURL(fs.realpathSync(process.argv[1])).href
  : undefined;

if (invokedUrl === moduleUrl) {
  const [
    source,
    destination,
    repoDir,
    homeDir,
    atlasRoot,
    dataDir,
    nodePath,
    jobRunner,
    codexPath,
    notificationApp,
    webBase,
    dbPath,
  ] =
    process.argv.slice(2);
  if (!source || !destination || !repoDir || !homeDir || !atlasRoot || !dataDir || !nodePath) {
    throw new Error(
      "Usage: render-lane-plist.mjs <source> <destination> <repo> <home> <atlas> <data> <node> [job-runner] [codex] [notification-app] [web-base] [db-path]",
    );
  }
  renderLanePlist({
    source,
    destination,
    repoDir,
    homeDir,
    atlasRoot,
    dataDir,
    nodePath,
    jobRunner,
    codexPath,
    notificationApp,
    webBase,
    dbPath,
  });
}
