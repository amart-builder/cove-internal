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
  const rendered = template
    .replaceAll(templateData, dataDir)
    .replaceAll(templateRepo, repoDir)
    .replaceAll(templateAtlas, atlasRoot)
    .replaceAll(templateHome, homeDir)
    .replaceAll(NODE_PLACEHOLDER, nodePath)
    .replaceAll(JOB_RUNNER_PLACEHOLDER, jobRunner)
    .replaceAll(CODEX_PLACEHOLDER, codexPath)
    .replaceAll(NOTIFICATION_APP_PLACEHOLDER, notificationApp);

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
  ] =
    process.argv.slice(2);
  if (!source || !destination || !repoDir || !homeDir || !atlasRoot || !dataDir || !nodePath) {
    throw new Error(
      "Usage: render-lane-plist.mjs <source> <destination> <repo> <home> <atlas> <data> <node> [job-runner] [codex] [notification-app]",
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
  });
}
