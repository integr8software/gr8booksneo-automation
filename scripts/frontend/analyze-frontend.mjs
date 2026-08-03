import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { detectHooks } from "../detector/hooks.mjs";
import { detectTypes } from "../detector/types.mjs";
import { detectFetching } from "../detector/fetching.mjs";
import { detectStructure } from "../detector/structure.mjs";
import { detectUi } from "../detector/ui.mjs";
import { detectConstants } from "../detector/constants.mjs";
import { detectData } from "../detector/data.mjs";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const CURRENT_DIRECTORY = path.dirname(CURRENT_FILE);

const AUTOMATION_ROOT = path.resolve(
  CURRENT_DIRECTORY,
  "../..",
);

const DEFAULT_CONFIG_PATH = path.join(
  AUTOMATION_ROOT,
  "configs",
  "frontend-standards.json",
);

const DEFAULT_SCHEMA_PATH = path.join(
  AUTOMATION_ROOT,
  "schemas",
  "frontend-resultschema.json",
);

const DEFAULT_OUTPUT_DIRECTORY = path.join(
  AUTOMATION_ROOT,
  "reports",
);

const DEFAULT_OUTPUT_FILE =
  "frontend-quality-results.json";

const DEFAULT_SUPPORTED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
];

const SEVERITY_ORDER = {
  blocker: 0,
  warning: 1,
  info: 2,
};

const DETECTORS = [
  {
    name: "hooks",
    execute: detectHooks,
  },
  {
    name: "types",
    execute: detectTypes,
  },
  {
    name: "fetching",
    execute: detectFetching,
  },
  {
    name: "structure",
    execute: detectStructure,
  },
  {
    name: "ui",
    execute: detectUi,
  },
  {
    name: "constants",
    execute: detectConstants,
  },
  {
    name: "data",
    execute: detectData,
  },
];

function normalizePath(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

function parseArguments(values) {
  const options = {
    repositoryRoot: process.cwd(),
    configPath: DEFAULT_CONFIG_PATH,
    schemaPath: DEFAULT_SCHEMA_PATH,
    outputDirectory: DEFAULT_OUTPUT_DIRECTORY,
    outputFile: DEFAULT_OUTPUT_FILE,
    baseReference: "",
    headReference: "HEAD",
    changedFilesFile: "",
    allFiles: false,
    failOnBlockers: undefined,
    failOnWarnings: undefined,
    maximumFindingsPerRule: undefined,
    pretty: true,
    verbose: false,
    help: false,
  };

  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];

    switch (argument) {
      case "--repository-root":
      case "--repo":
        options.repositoryRoot =
          values[index + 1] ?? options.repositoryRoot;
        index += 1;
        break;

      case "--config":
        options.configPath =
          values[index + 1] ?? options.configPath;
        index += 1;
        break;

      case "--schema":
        options.schemaPath =
          values[index + 1] ?? options.schemaPath;
        index += 1;
        break;

      case "--output-directory":
      case "--output-dir":
        options.outputDirectory =
          values[index + 1] ?? options.outputDirectory;
        index += 1;
        break;

      case "--output":
        options.outputFile =
          values[index + 1] ?? options.outputFile;
        index += 1;
        break;

      case "--base":
      case "--base-reference":
        options.baseReference =
          values[index + 1] ?? "";
        index += 1;
        break;

      case "--head":
      case "--head-reference":
        options.headReference =
          values[index + 1] ?? "HEAD";
        index += 1;
        break;

      case "--changed-files-file":
        options.changedFilesFile =
          values[index + 1] ?? "";
        index += 1;
        break;

      case "--all-files":
        options.allFiles = true;
        break;

      case "--fail-on-blockers":
        options.failOnBlockers = true;
        break;

      case "--no-fail-on-blockers":
        options.failOnBlockers = false;
        break;

      case "--fail-on-warnings":
        options.failOnWarnings = true;
        break;

      case "--no-fail-on-warnings":
        options.failOnWarnings = false;
        break;

      case "--maximum-findings-per-rule":
        options.maximumFindingsPerRule = Number(
          values[index + 1],
        );
        index += 1;
        break;

      case "--compact":
        options.pretty = false;
        break;

      case "--verbose":
        options.verbose = true;
        break;

      case "--help":
      case "-h":
        options.help = true;
        break;

      default:
        if (argument.startsWith("--")) {
          throw new Error(
            `Unknown argument: ${argument}`,
          );
        }
    }
  }

  return options;
}

function printHelp() {
  console.log(`
Frontend PR Quality Analyzer

Usage:
  node scripts/frontend/analyze-frontend.mjs [options]

Options:
  --repository-root <path>          Frontend repository root
  --config <path>                   Standards configuration file
  --schema <path>                   Result schema path
  --output-directory <path>         Report output directory
  --output <filename>               JSON report filename
  --base <git-reference>            Base commit or branch
  --head <git-reference>            Head commit or branch
  --changed-files-file <path>       Read changed files from a text file
  --all-files                       Analyze all supported frontend files
  --fail-on-blockers                Exit with code 1 when blockers exist
  --no-fail-on-blockers             Do not fail when blockers exist
  --fail-on-warnings                Exit with code 1 when warnings exist
  --no-fail-on-warnings             Do not fail when warnings exist
  --maximum-findings-per-rule <n>   Limit findings per rule
  --compact                         Write compact JSON
  --verbose                         Print detector details
  --help                            Show this help
`);
}

function resolvePath(value, fallbackRoot = process.cwd()) {
  if (!value) {
    return fallbackRoot;
  }

  return path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(fallbackRoot, value);
}

function readJsonFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `${label} was not found: ${filePath}`,
    );
  }

  try {
    return JSON.parse(
      fs.readFileSync(filePath, "utf8"),
    );
  } catch (error) {
    throw new Error(
      `${label} contains invalid JSON: ${error.message}`,
    );
  }
}

function executeGit(repositoryRoot, argumentsList) {
  try {
    return execFileSync(
      "git",
      argumentsList,
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  } catch (error) {
    const standardError =
      error.stderr?.toString().trim() ?? "";

    throw new Error(
      standardError ||
        `Git command failed: git ${argumentsList.join(" ")}`,
    );
  }
}

function isGitRepository(repositoryRoot) {
  try {
    return (
      executeGit(repositoryRoot, [
        "rev-parse",
        "--is-inside-work-tree",
      ]) === "true"
    );
  } catch {
    return false;
  }
}

function resolveBaseReference(
  repositoryRoot,
  requestedBase,
) {
  if (requestedBase) {
    return requestedBase;
  }

  const environmentCandidates = [
    process.env.QA_BASE_REFERENCE,
    process.env.GITHUB_BASE_SHA,
    process.env.GITHUB_BASE_REF
      ? `origin/${process.env.GITHUB_BASE_REF}`
      : "",
  ].filter(Boolean);

  for (const candidate of environmentCandidates) {
    try {
      executeGit(repositoryRoot, [
        "rev-parse",
        "--verify",
        candidate,
      ]);

      return candidate;
    } catch {
      // Try the next available base candidate.
    }
  }

  const fallbackCandidates = [
    "origin/develop",
    "develop",
    "origin/main",
    "main",
    "origin/master",
    "master",
    "HEAD~1",
  ];

  for (const candidate of fallbackCandidates) {
    try {
      executeGit(repositoryRoot, [
        "rev-parse",
        "--verify",
        candidate,
      ]);

      return candidate;
    } catch {
      // Try the next fallback.
    }
  }

  return "";
}

function readChangedFilesFromTextFile(
  repositoryRoot,
  filePath,
) {
  const absolutePath = resolvePath(
    filePath,
    repositoryRoot,
  );

  if (!fs.existsSync(absolutePath)) {
    throw new Error(
      `Changed-files input was not found: ${absolutePath}`,
    );
  }

  return fs
    .readFileSync(absolutePath, "utf8")
    .split(/\r?\n/)
    .map((file) => normalizePath(file.trim()))
    .filter(Boolean);
}

function getGitChangedFiles({
  repositoryRoot,
  baseReference,
  headReference,
}) {
  if (!isGitRepository(repositoryRoot)) {
    throw new Error(
      `Repository root is not a Git working tree: ${repositoryRoot}`,
    );
  }

  if (!baseReference) {
    throw new Error(
      "Unable to determine a Git base reference. Pass --base explicitly.",
    );
  }

  const range = `${baseReference}...${headReference}`;

  const output = executeGit(repositoryRoot, [
    "diff",
    "--name-only",
    "--diff-filter=ACMRTUXB",
    range,
  ]);

  if (!output) {
    return [];
  }

  return output
    .split(/\r?\n/)
    .map((file) => normalizePath(file.trim()))
    .filter(Boolean);
}

function walkRepositoryFiles({
  repositoryRoot,
  currentDirectory,
  config,
  results,
}) {
  let entries;

  try {
    entries = fs.readdirSync(currentDirectory, {
      withFileTypes: true,
    });
  } catch {
    return;
  }

  for (const entry of entries) {
    const absolutePath = path.join(
      currentDirectory,
      entry.name,
    );

    const relativePath = normalizePath(
      path.relative(repositoryRoot, absolutePath),
    );

    if (isIgnoredFile(relativePath, config)) {
      continue;
    }

    if (entry.isDirectory()) {
      walkRepositoryFiles({
        repositoryRoot,
        currentDirectory: absolutePath,
        config,
        results,
      });

      continue;
    }

    if (
      entry.isFile() &&
      isSupportedFile(relativePath, config)
    ) {
      results.push(relativePath);
    }
  }
}

function getAllSupportedFiles(repositoryRoot, config) {
  const sourceRoot =
    config.sourceRoot || "app/src";

  const absoluteSourceRoot = resolvePath(
    sourceRoot,
    repositoryRoot,
  );

  if (!fs.existsSync(absoluteSourceRoot)) {
    throw new Error(
      `Configured source root does not exist: ${absoluteSourceRoot}`,
    );
  }

  const results = [];

  walkRepositoryFiles({
    repositoryRoot,
    currentDirectory: absoluteSourceRoot,
    config,
    results,
  });

  return results;
}

function isSupportedFile(file, config) {
  const extension = path.extname(file).toLowerCase();

  const supportedExtensions =
    config.supportedExtensions ??
    DEFAULT_SUPPORTED_EXTENSIONS;

  return supportedExtensions
    .map((item) => item.toLowerCase())
    .includes(extension);
}

function isIgnoredFile(file, config) {
  const normalizedFile =
    `/${normalizePath(file).toLowerCase()}/`;

  const ignoredPaths = config.ignoredPaths ?? [];

  for (const ignoredPath of ignoredPaths) {
    const normalizedIgnored = normalizePath(
      ignoredPath,
    )
      .replace(/^\/+|\/+$/g, "")
      .toLowerCase();

    if (
      normalizedIgnored &&
      normalizedFile.includes(
        `/${normalizedIgnored}/`,
      )
    ) {
      return true;
    }
  }

  const generatedPatterns =
    config.generatedCodePatterns ?? [];

  return generatedPatterns.some((pattern) => {
    const normalizedPattern = normalizePath(
      pattern,
    ).toLowerCase();

    return (
      normalizedPattern &&
      normalizePath(file)
        .toLowerCase()
        .includes(normalizedPattern)
    );
  });
}

function filterChangedFiles(files, config) {
  return [
    ...new Set(
      files
        .map(normalizePath)
        .filter(Boolean)
        .filter((file) =>
          isSupportedFile(file, config),
        )
        .filter(
          (file) => !isIgnoredFile(file, config),
        ),
    ),
  ].sort((left, right) =>
    left.localeCompare(right),
  );
}

function normalizeFinding(
  finding,
  detectorName,
  index,
) {
  const severity =
    String(finding?.severity ?? "warning")
      .trim()
      .toLowerCase();

  return {
    id:
      finding?.id ??
      `${detectorName}-${String(index + 1).padStart(4, "0")}`,
    category:
      finding?.category ?? detectorName,
    ruleId:
      finding?.ruleId ??
      `${detectorName}.unknown`,
    severity:
      severity in SEVERITY_ORDER
        ? severity
        : "warning",
    title:
      finding?.title ??
      "Frontend quality finding",
    message:
      finding?.message ?? "",
    recommendation:
      finding?.recommendation ?? "",
    file: normalizePath(finding?.file ?? ""),
    line:
      Number.isInteger(finding?.line)
        ? finding.line
        : null,
    column:
      Number.isInteger(finding?.column)
        ? finding.column
        : null,
    endLine:
      Number.isInteger(finding?.endLine)
        ? finding.endLine
        : null,
    endColumn:
      Number.isInteger(finding?.endColumn)
        ? finding.endColumn
        : null,
    codeSnippet:
      finding?.codeSnippet ?? "",
    relatedFiles: Array.isArray(
      finding?.relatedFiles,
    )
      ? finding.relatedFiles.map(normalizePath)
      : [],
    evidence: Array.isArray(finding?.evidence)
      ? finding.evidence.map(String)
      : [],
    detector:
      finding?.detector ?? detectorName,
    confidence:
      finding?.confidence ?? "medium",
  };
}

function sortFindings(findings) {
  return [...findings].sort((left, right) => {
    const severityDifference =
      (SEVERITY_ORDER[left.severity] ?? 99) -
      (SEVERITY_ORDER[right.severity] ?? 99);

    if (severityDifference !== 0) {
      return severityDifference;
    }

    const fileDifference =
      left.file.localeCompare(right.file);

    if (fileDifference !== 0) {
      return fileDifference;
    }

    const lineDifference =
      (left.line ?? Number.MAX_SAFE_INTEGER) -
      (right.line ?? Number.MAX_SAFE_INTEGER);

    if (lineDifference !== 0) {
      return lineDifference;
    }

    return left.ruleId.localeCompare(
      right.ruleId,
    );
  });
}

function limitFindingsPerRule(
  findings,
  maximumFindingsPerRule,
) {
  if (
    !Number.isFinite(maximumFindingsPerRule) ||
    maximumFindingsPerRule <= 0
  ) {
    return findings;
  }

  const counts = new Map();

  return findings.filter((finding) => {
    const key = finding.ruleId;
    const count = counts.get(key) ?? 0;

    if (count >= maximumFindingsPerRule) {
      return false;
    }

    counts.set(key, count + 1);
    return true;
  });
}

function buildCategorySummary(findings) {
  const categories = {};

  for (const detector of DETECTORS) {
    categories[detector.name] = {
      total: 0,
      blockers: 0,
      warnings: 0,
      info: 0,
    };
  }

  for (const finding of findings) {
    const category =
      finding.category || finding.detector;

    if (!categories[category]) {
      categories[category] = {
        total: 0,
        blockers: 0,
        warnings: 0,
        info: 0,
      };
    }

    categories[category].total += 1;

    if (finding.severity === "blocker") {
      categories[category].blockers += 1;
    } else if (
      finding.severity === "warning"
    ) {
      categories[category].warnings += 1;
    } else {
      categories[category].info += 1;
    }
  }

  return categories;
}

function buildRuleSummary(findings) {
  const rules = {};

  for (const finding of findings) {
    if (!rules[finding.ruleId]) {
      rules[finding.ruleId] = {
        ruleId: finding.ruleId,
        category: finding.category,
        severity: finding.severity,
        count: 0,
      };
    }

    rules[finding.ruleId].count += 1;
  }

  return Object.values(rules).sort(
    (left, right) => {
      const severityDifference =
        (SEVERITY_ORDER[left.severity] ?? 99) -
        (SEVERITY_ORDER[right.severity] ?? 99);

      if (severityDifference !== 0) {
        return severityDifference;
      }

      return right.count - left.count;
    },
  );
}

function getGitMetadata(repositoryRoot) {
  if (!isGitRepository(repositoryRoot)) {
    return {
      repository: path.basename(repositoryRoot),
      branch: "",
      commit: "",
      commitShort: "",
    };
  }

  let branch = "";
  let commit = "";

  try {
    branch = executeGit(repositoryRoot, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
  } catch {
    branch = "";
  }

  try {
    commit = executeGit(repositoryRoot, [
      "rev-parse",
      "HEAD",
    ]);
  } catch {
    commit = "";
  }

  return {
    repository: path.basename(repositoryRoot),
    branch,
    commit,
    commitShort: commit.slice(0, 8),
  };
}

function determineStatus({
  blockers,
  warnings,
}) {
  if (blockers > 0) {
    return {
      status: "blocked",
      label: "Changes Required",
      readyToProceed: false,
    };
  }

  if (warnings > 0) {
    return {
      status: "warning",
      label: "Ready With Warnings",
      readyToProceed: true,
    };
  }

  return {
    status: "passed",
    label: "Ready To Proceed",
    readyToProceed: true,
  };
}

function calculateSummary(findings) {
  const blockers = findings.filter(
    (finding) =>
      finding.severity === "blocker",
  ).length;

  const warnings = findings.filter(
    (finding) =>
      finding.severity === "warning",
  ).length;

  const info = findings.filter(
    (finding) => finding.severity === "info",
  ).length;

  return {
    total: findings.length,
    blockers,
    warnings,
    info,
    categories: buildCategorySummary(findings),
    rules: buildRuleSummary(findings),
    ...determineStatus({
      blockers,
      warnings,
    }),
  };
}

function resolveReportingOptions(
  config,
  cliOptions,
) {
  const reporting = config.reporting ?? {};
  const failRules = reporting.failRules ?? {};

  return {
    failOnBlockers:
      cliOptions.failOnBlockers ??
      failRules.failOnBlockers ??
      true,
    failOnWarnings:
      cliOptions.failOnWarnings ??
      failRules.failOnWarnings ??
      false,
    maximumFindingsPerRule:
      cliOptions.maximumFindingsPerRule ??
      reporting.maximumFindingsPerRule ??
      50,
  };
}

async function runDetectors({
  repositoryRoot,
  files,
  config,
  verbose,
}) {
  const findings = [];
  const detectorRuns = [];

  for (const detector of DETECTORS) {
    const startedAt = Date.now();

    try {
      const detectorFindings =
        await detector.execute({
          repositoryRoot,
          files,
          config,
        });

      const normalizedFindings =
        Array.isArray(detectorFindings)
          ? detectorFindings.map(
              (finding, index) =>
                normalizeFinding(
                  finding,
                  detector.name,
                  index,
                ),
            )
          : [];

      findings.push(...normalizedFindings);

      detectorRuns.push({
        detector: detector.name,
        status: "completed",
        findings: normalizedFindings.length,
        durationMs: Date.now() - startedAt,
        error: null,
      });

      if (verbose) {
        console.log(
          `  ${detector.name.padEnd(12)} ${String(normalizedFindings.length).padStart(3)} finding(s)`,
        );
      }
    } catch (error) {
      detectorRuns.push({
        detector: detector.name,
        status: "failed",
        findings: 0,
        durationMs: Date.now() - startedAt,
        error: error.message,
      });

      findings.push(
        normalizeFinding(
          {
            category: detector.name,
            ruleId: `${detector.name}.detectorFailure`,
            severity: "blocker",
            title: `${detector.name} detector failed`,
            message: error.message,
            recommendation:
              "Review the detector error and rerun the frontend quality analysis.",
            detector: detector.name,
            confidence: "high",
            evidence: [
              error.stack ?? error.message,
            ],
          },
          detector.name,
          0,
        ),
      );

      console.error(
        `  ${detector.name} detector failed: ${error.message}`,
      );
    }
  }

  return {
    findings,
    detectorRuns,
  };
}

function writeJsonReport(
  outputPath,
  report,
  pretty,
) {
  fs.mkdirSync(path.dirname(outputPath), {
    recursive: true,
  });

  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      report,
      null,
      pretty ? 2 : 0,
    ),
    "utf8",
  );
}

function getExitCode(
  summary,
  reportingOptions,
) {
  if (
    reportingOptions.failOnBlockers &&
    summary.blockers > 0
  ) {
    return 1;
  }

  if (
    reportingOptions.failOnWarnings &&
    summary.warnings > 0
  ) {
    return 1;
  }

  return 0;
}

function printResult({
  report,
  outputPath,
}) {
  const { summary } = report;

  console.log("");
  console.log("Frontend PR Quality Analysis");
  console.log("----------------------------");
  console.log(
    `Repository : ${report.repository.name}`,
  );
  console.log(
    `Branch     : ${report.repository.branch || "Unknown"}`,
  );
  console.log(
    `Changed    : ${report.analysis.changedFileCount}`,
  );
  console.log(
    `Findings   : ${summary.total}`,
  );
  console.log(
    `Blockers   : ${summary.blockers}`,
  );
  console.log(
    `Warnings   : ${summary.warnings}`,
  );
  console.log(
    `Info       : ${summary.info}`,
  );
  console.log(
    `Decision   : ${summary.label}`,
  );
  console.log(
    `Report     : ${outputPath}`,
  );
  console.log("");
}

export async function analyzeFrontend(
  suppliedOptions = {},
) {
  const options = {
    ...parseArguments([]),
    ...suppliedOptions,
  };

  const repositoryRoot = resolvePath(
    options.repositoryRoot,
  );

  const configPath = resolvePath(
    options.configPath,
    AUTOMATION_ROOT,
  );

  const schemaPath = resolvePath(
    options.schemaPath,
    AUTOMATION_ROOT,
  );

  const outputDirectory = resolvePath(
    options.outputDirectory,
    AUTOMATION_ROOT,
  );

  const outputPath = path.join(
    outputDirectory,
    options.outputFile,
  );

  if (!fs.existsSync(repositoryRoot)) {
    throw new Error(
      `Repository root does not exist: ${repositoryRoot}`,
    );
  }

  const config = readJsonFile(
    configPath,
    "Frontend standards configuration",
  );

  // Read the schema now so invalid or missing schema paths fail early.
  // Full JSON Schema validation can be added later through Ajv.
  readJsonFile(
    schemaPath,
    "Frontend results schema",
  );

  const baseReference = options.allFiles
    ? ""
    : resolveBaseReference(
        repositoryRoot,
        options.baseReference,
      );

  const headReference =
    options.headReference || "HEAD";

  let discoveredFiles;
  let analysisMode;

  if (options.allFiles) {
    analysisMode = "all-files";
    discoveredFiles = getAllSupportedFiles(
      repositoryRoot,
      config,
    );
  } else if (options.changedFilesFile) {
    analysisMode = "changed-files-input";
    discoveredFiles =
      readChangedFilesFromTextFile(
        repositoryRoot,
        options.changedFilesFile,
      );
  } else {
    analysisMode = "git-diff";
    discoveredFiles = getGitChangedFiles({
      repositoryRoot,
      baseReference,
      headReference,
    });
  }

  const changedFiles = filterChangedFiles(
    discoveredFiles,
    config,
  );

  console.log(
    `Analyzing ${changedFiles.length} frontend file(s)...`,
  );

  const detectorResult = await runDetectors({
    repositoryRoot,
    files: changedFiles,
    config,
    verbose: options.verbose,
  });

  const reportingOptions =
    resolveReportingOptions(config, options);

  const sortedFindings = sortFindings(
    detectorResult.findings,
  );

  const limitedFindings =
    limitFindingsPerRule(
      sortedFindings,
      reportingOptions.maximumFindingsPerRule,
    );

  const summary = calculateSummary(
    limitedFindings,
  );

  const gitMetadata = getGitMetadata(
    repositoryRoot,
  );

  const generatedAt = new Date().toISOString();

  const report = {
    schemaVersion:
      config.metadata?.schemaVersion ??
      config.schemaVersion ??
      "1.0.0",

    reportType: "frontend-pr-quality",

    generatedAt,

    tool: {
      name:
        config.metadata?.name ??
        "Gr8BooksNeo Frontend PR Quality",
      version:
        config.metadata?.version ??
        "1.0.0",
    },

    repository: {
      name: gitMetadata.repository,
      root: normalizePath(repositoryRoot),
      branch: gitMetadata.branch,
      commit: gitMetadata.commit,
      commitShort: gitMetadata.commitShort,
      baseReference,
      headReference,
    },

    analysis: {
      mode: analysisMode,
      sourceRoot:
        config.sourceRoot ?? "app/src",
      discoveredFileCount:
        discoveredFiles.length,
      changedFileCount:
        changedFiles.length,
      changedFiles,
      detectorCount: DETECTORS.length,
      completedDetectorCount:
        detectorResult.detectorRuns.filter(
          (run) => run.status === "completed",
        ).length,
      failedDetectorCount:
        detectorResult.detectorRuns.filter(
          (run) => run.status === "failed",
        ).length,
      detectorRuns:
        detectorResult.detectorRuns,
      maximumFindingsPerRule:
        reportingOptions.maximumFindingsPerRule,
    },

    summary,

    findings: limitedFindings,

    decision: {
      status: summary.status,
      label: summary.label,
      readyToProceed:
        summary.readyToProceed,
      failOnBlockers:
        reportingOptions.failOnBlockers,
      failOnWarnings:
        reportingOptions.failOnWarnings,
      exitCode: getExitCode(
        summary,
        reportingOptions,
      ),
    },
  };

  writeJsonReport(
    outputPath,
    report,
    options.pretty,
  );

  printResult({
    report,
    outputPath,
  });

  return {
    report,
    outputPath,
    exitCode: report.decision.exitCode,
  };
}

async function main() {
  let options;

  try {
    options = parseArguments(
      process.argv.slice(2),
    );

    if (options.help) {
      printHelp();
      return;
    }

    const result = await analyzeFrontend(
      options,
    );

    process.exitCode = result.exitCode;
  } catch (error) {
    console.error("");
    console.error(
      "Frontend quality analysis failed.",
    );
    console.error(error.message);

    if (options?.verbose && error.stack) {
      console.error("");
      console.error(error.stack);
    }

    process.exitCode = 2;
  }
}

const invokedFile = process.argv[1]
  ? path.resolve(process.argv[1])
  : "";

if (invokedFile === CURRENT_FILE) {
  await main();
}

export default analyzeFrontend;