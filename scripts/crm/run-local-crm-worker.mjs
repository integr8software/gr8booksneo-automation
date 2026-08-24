import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const repositories = [
  {
    repository: "integr8software/gr8bookslite-backend",
    artifactPrefix: "backend-pr-quality-",
  },
  {
    repository: "integr8software/gr8bookslite-frontend",
    artifactPrefix: "frontend-pr-quality-",
  },
];

const automationRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
  "..",
);

const publisher = path.join(
  automationRoot,
  "scripts",
  "crm",
  "publish-crm-tickets.mjs",
);

const stateDirectory = path.join(
  automationRoot,
  ".local",
  "crm-worker",
);

const downloadsDirectory = path.join(
  stateDirectory,
  "downloads",
);

const stateFile = path.join(
  stateDirectory,
  "processed-runs.json",
);

const pollSeconds = Math.max(
  30,
  Number(process.env.CRM_WORKER_POLL_SECONDS || "120"),
);

const dryRun =
  String(process.env.CRM_DRY_RUN || "false").toLowerCase() === "true";

function gh(args, options = {}) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 100,
    ...options,
  }).trim();
}

function readState() {
  if (!fs.existsSync(stateFile)) {
    return { processed: {} };
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return { processed: {} };
  }
}

function writeState(state) {
  fs.mkdirSync(stateDirectory, { recursive: true });
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
}

function ensureRequirements() {
  if (!fs.existsSync(publisher)) {
    throw new Error(`CRM publisher not found: ${publisher}`);
  }

  try {
    gh(["--version"]);
    gh(["auth", "status"]);
  } catch {
    throw new Error(
      "GitHub CLI is missing or not authenticated. Install gh, then run: gh auth login",
    );
  }
}

function listSuccessfulPushRuns(repository) {
  const output = gh([
    "run",
    "list",
    "--repo",
    repository,
    "--event",
    "push",
    "--status",
    "success",
    "--limit",
    "30",
    "--json",
    "databaseId,createdAt,headSha,displayTitle,workflowName",
  ]);

  return output ? JSON.parse(output) : [];
}

function listArtifacts(repository, runId) {
  const output = gh([
    "api",
    `repos/${repository}/actions/runs/${runId}/artifacts`,
    "--paginate",
  ]);

  const parsed = output ? JSON.parse(output) : {};
  return Array.isArray(parsed.artifacts) ? parsed.artifacts : [];
}

function findTicketPayload(directory) {
  const queue = [directory];

  while (queue.length > 0) {
    const current = queue.shift();

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }

      if (
        entry.isFile() &&
        entry.name.toLowerCase() === "crm-tickets.json"
      ) {
        return full;
      }
    }
  }

  return null;
}

function downloadArtifact(repository, artifact, runId) {
  const destination = path.join(
    downloadsDirectory,
    repository.replaceAll("/", "__"),
    String(runId),
  );

  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });

  gh([
    "run",
    "download",
    String(runId),
    "--repo",
    repository,
    "--name",
    artifact.name,
    "--dir",
    destination,
  ]);

  return destination;
}

function publishTickets(ticketPath) {
  const result = spawnSync(
    process.execPath,
    [publisher, ticketPath],
    {
      cwd: automationRoot,
      env: {
        ...process.env,
        CRM_DRY_RUN: process.env.CRM_DRY_RUN || "false",
        CRM_MAX_TICKETS: process.env.CRM_MAX_TICKETS || "200",
      },
      stdio: "inherit",
    },
  );

  return result.status === 0;
}

async function processOnce() {
  const state = readState();

  for (const config of repositories) {
    console.log(`\nChecking ${config.repository}...`);

    const runs = listSuccessfulPushRuns(
      config.repository,
    ).sort(
      (a, b) =>
        new Date(a.createdAt).getTime() -
        new Date(b.createdAt).getTime(),
    );

    for (const run of runs) {
      const key = `${config.repository}#${run.databaseId}`;

      if (state.processed[key]) {
        continue;
      }

      const artifacts = listArtifacts(
        config.repository,
        run.databaseId,
      );

      const artifact = artifacts.find(
        (item) =>
          !item.expired &&
          String(item.name || "").startsWith(config.artifactPrefix),
      );

      if (!artifact) {
        console.log(
          `Run ${run.databaseId} (${run.workflowName || run.displayTitle || "workflow"}): ` +
            `no matching ${config.artifactPrefix} artifact; skipping for now.`,
        );
        continue;
      }

      console.log(
        `Run ${run.databaseId}: downloading ${artifact.name}...`,
      );

      const downloaded = downloadArtifact(
        config.repository,
        artifact,
        run.databaseId,
      );

      const ticketsPath = findTicketPayload(downloaded);

      if (!ticketsPath) {
        console.log(
          `Run ${run.databaseId}: crm-tickets.json not found; marking as skipped.`,
        );

        state.processed[key] = {
          status: "no-payload",
          processedAt: new Date().toISOString(),
          headSha: run.headSha,
        };
        writeState(state);
        continue;
      }

      console.log(
        `Run ${run.databaseId}: publishing CRM tickets headlessly...`,
      );

      const success = publishTickets(ticketsPath);

      if (!success) {
        console.error(
          `Run ${run.databaseId}: CRM publishing failed. It will be retried on the next poll.`,
        );
        continue;
      }

      if (dryRun) {
        console.log(
          `Run ${run.databaseId}: dry run completed; run was NOT marked as processed.`,
        );
        continue;
      }

      state.processed[key] = {
        status: "published",
        processedAt: new Date().toISOString(),
        headSha: run.headSha,
      };
      writeState(state);

      console.log(
        `Run ${run.databaseId}: CRM publishing completed.`,
      );
    }
  }
}

async function main() {
  ensureRequirements();

  fs.mkdirSync(downloadsDirectory, { recursive: true });

  console.log("Gr8BooksNeo local CRM worker started.");

  if (dryRun) {
    console.log("CRM_DRY_RUN=true — running one test cycle only.");
    await processOnce();
    console.log("Dry-run cycle finished. No runs were marked as processed.");
    return;
  }

  console.log(`Polling every ${pollSeconds} second(s).`);
  console.log("Close this terminal or press Ctrl+C to stop.");

  while (true) {
    try {
      await processOnce();
    } catch (error) {
      console.error(
        `CRM worker cycle failed: ${error?.message || error}`,
      );
    }

    await new Promise(
      (resolve) => setTimeout(resolve, pollSeconds * 1000),
    );
  }
}

await main();