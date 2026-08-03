import fs from "node:fs";
import path from "node:path";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

const FETCH_PATTERN = /\bfetch\s*\(/g;

const AXIOS_DIRECT_PATTERN =
  /\baxios\s*\.\s*(get|post|put|patch|delete|request)\s*\(/gi;

const API_CLIENT_PATTERN =
  /\b(api|apiClient|http|httpClient|axiosInstance)\s*\.\s*(get|post|put|patch|delete|request)\s*\(/gi;

const TANSTACK_QUERY_PATTERN =
  /\b(useQuery|useMutation|useInfiniteQuery|useQueries|useSuspenseQuery|queryOptions|mutationOptions)\s*\(/;

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function getLineNumber(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function getCodeLine(source, lineNumber) {
  return source.split(/\r?\n/)[lineNumber - 1]?.trim() ?? "";
}

function createFinding({
  ruleId,
  severity,
  title,
  message,
  recommendation,
  file,
  line = null,
  column = null,
  codeSnippet = "",
  relatedFiles = [],
  evidence = [],
  confidence = "high",
}) {
  return {
    category: "fetching",
    ruleId,
    severity,
    title,
    message,
    recommendation,
    file: normalizePath(file),
    line,
    column,
    endLine: null,
    endColumn: null,
    codeSnippet,
    relatedFiles: relatedFiles.map(normalizePath),
    evidence,
    detector: "fetching",
    confidence,
  };
}

function isIgnored(file, config) {
  const normalized = `/${normalizePath(file).toLowerCase()}/`;

  return (config.ignoredPaths ?? []).some((ignoredPath) => {
    const ignored = normalizePath(ignoredPath).toLowerCase();
    return normalized.includes(`/${ignored}/`);
  });
}

function isGeneratedFile(file, config) {
  const normalized = normalizePath(file).toLowerCase();

  return (config.generatedCodePatterns ?? []).some((pattern) =>
    normalized.includes(normalizePath(pattern).toLowerCase()),
  );
}

function isInsideConfiguredDirectory(file, directories = []) {
  const normalized = normalizePath(file);

  return directories.some((directory) => {
    const root = normalizePath(directory).replace(/\/+$/, "");

    return normalized === root || normalized.startsWith(`${root}/`);
  });
}

function isUiFile(file, config) {
  return isInsideConfiguredDirectory(
    file,
    config.ui?.uiRootDirectories ?? ["app/src/ui"],
  );
}

function isServiceFile(file, config) {
  return isInsideConfiguredDirectory(
    file,
    config.fetching?.serviceDirectories ?? ["app/src/services"],
  );
}

function isHookFile(file, config) {
  const normalized = normalizePath(file);
  const directory = path.posix.dirname(normalized);

  const sharedHookDirectories =
    config.hooks?.sharedHookDirectories ?? [
      "app/src/hooks",
      "app/src/shared/hooks",
    ];

  if (
    sharedHookDirectories.some((hookDirectory) => {
      const root = normalizePath(hookDirectory).replace(/\/+$/, "");
      return directory === root || directory.startsWith(`${root}/`);
    })
  ) {
    return true;
  }

  const featureHookDirectoryNames =
    config.hooks?.featureHookDirectoryNames ?? ["hooks"];

  return directory
    .split("/")
    .some((segment) => featureHookDirectoryNames.includes(segment));
}

function findMatches(source, pattern) {
  const regex = new RegExp(pattern.source, pattern.flags);
  return [...source.matchAll(regex)];
}

function hasApiRequest(source) {
  return (
    FETCH_PATTERN.test(source) ||
    AXIOS_DIRECT_PATTERN.test(source) ||
    API_CLIENT_PATTERN.test(source)
  );
}

function detectFetchUsage({
  file,
  source,
  config,
  findings,
}) {
  const rule = config.fetching?.rules?.fetchUsage;

  if (!rule?.enabled) {
    return;
  }

  for (const match of findMatches(source, FETCH_PATTERN)) {
    const line = getLineNumber(source, match.index ?? 0);

    findings.push(
      createFinding({
        ruleId: "fetching.fetchUsage",
        severity: rule.severity,
        title: "fetch() usage detected",
        message:
          "The project standard requires Axios for API requests, but fetch() was found.",
        recommendation:
          "Move the request into the API service layer and use the configured Axios client.",
        file,
        line,
        column: 1,
        codeSnippet: getCodeLine(source, line),
        confidence: "high",
      }),
    );
  }
}

function detectDirectAxiosInUi({
  file,
  source,
  config,
  findings,
}) {
  const rule = config.fetching?.rules?.directAxiosInUi;

  if (!rule?.enabled || !isUiFile(file, config)) {
    return;
  }

  const matches = [
    ...findMatches(source, AXIOS_DIRECT_PATTERN),
    ...findMatches(source, API_CLIENT_PATTERN),
  ].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  for (const match of matches) {
    const line = getLineNumber(source, match.index ?? 0);

    findings.push(
      createFinding({
        ruleId: "fetching.directAxiosInUi",
        severity: rule.severity,
        title: "Direct API request found inside UI",
        message:
          "A UI component is directly calling Axios or an API client.",
        recommendation:
          "Move the request into the service layer, then expose it through a custom TanStack Query hook.",
        file,
        line,
        column: 1,
        codeSnippet: getCodeLine(source, line),
        confidence: "high",
      }),
    );
  }
}

function detectApiCallOutsideServiceLayer({
  file,
  source,
  config,
  findings,
}) {
  const rule = config.fetching?.rules?.apiCallOutsideServiceLayer;

  if (!rule?.enabled || isServiceFile(file, config)) {
    return;
  }

  if (isUiFile(file, config)) {
    return;
  }

  const matches = [
    ...findMatches(source, AXIOS_DIRECT_PATTERN),
    ...findMatches(source, API_CLIENT_PATTERN),
  ];

  if (matches.length === 0) {
    return;
  }

  const firstMatch = matches[0];
  const line = getLineNumber(source, firstMatch.index ?? 0);

  findings.push(
    createFinding({
      ruleId: "fetching.apiCallOutsideServiceLayer",
      severity: rule.severity,
      title: "API request may be outside the service layer",
      message:
        "An Axios or API-client request was found outside the configured services directory.",
      recommendation:
        "Place API request functions in the services layer. Hooks should call service functions rather than Axios directly.",
      file,
      line,
      column: 1,
      codeSnippet: getCodeLine(source, line),
      confidence: isHookFile(file, config) ? "high" : "medium",
    }),
  );
}

function sourceContainsAnyIdentifier(source, identifiers = []) {
  return identifiers.some((identifier) => {
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`).test(source);
  });
}

function detectMissingLoadingState({
  file,
  source,
  config,
  findings,
}) {
  const rule = config.fetching?.rules?.missingLoadingState;

  if (
    !rule?.enabled ||
    !isUiFile(file, config) ||
    !TANSTACK_QUERY_PATTERN.test(source)
  ) {
    return;
  }

  const identifiers =
    config.fetching?.loadingIdentifiers ?? [
      "isLoading",
      "isPending",
      "loading",
      "pending",
    ];

  if (sourceContainsAnyIdentifier(source, identifiers)) {
    return;
  }

  findings.push(
    createFinding({
      ruleId: "fetching.missingLoadingState",
      severity: rule.severity,
      title: "Loading state may be missing",
      message:
        "The component uses TanStack Query but no recognized loading-state handling was found.",
      recommendation:
        "Handle the query loading or pending state before rendering the final UI.",
      file,
      confidence: "medium",
    }),
  );
}

function detectMissingErrorState({
  file,
  source,
  config,
  findings,
}) {
  const rule = config.fetching?.rules?.missingErrorState;

  if (
    !rule?.enabled ||
    !isUiFile(file, config) ||
    !TANSTACK_QUERY_PATTERN.test(source)
  ) {
    return;
  }

  const identifiers =
    config.fetching?.errorIdentifiers ?? [
      "isError",
      "error",
      "hasError",
    ];

  if (sourceContainsAnyIdentifier(source, identifiers)) {
    return;
  }

  findings.push(
    createFinding({
      ruleId: "fetching.missingErrorState",
      severity: rule.severity,
      title: "Error state may be missing",
      message:
        "The component uses TanStack Query but no recognized error-state handling was found.",
      recommendation:
        "Render or otherwise handle the query error state.",
      file,
      confidence: "medium",
    }),
  );
}

function detectMissingEmptyState({
  file,
  source,
  config,
  findings,
}) {
  const rule = config.fetching?.rules?.missingEmptyState;

  if (
    !rule?.enabled ||
    !isUiFile(file, config) ||
    !TANSTACK_QUERY_PATTERN.test(source)
  ) {
    return;
  }

  const identifiers =
    config.fetching?.emptyStateIdentifiers ?? [
      "isEmpty",
      "empty",
      "EmptyState",
      "NoData",
      "NoRecords",
    ];

  const hasLengthCheck =
    /\.length\s*===\s*0\b/.test(source) ||
    /!\s*[A-Za-z_$][\w$]*\.length\b/.test(source) ||
    /\?\.\s*length\s*===\s*0\b/.test(source);

  if (
    sourceContainsAnyIdentifier(source, identifiers) ||
    hasLengthCheck
  ) {
    return;
  }

  findings.push(
    createFinding({
      ruleId: "fetching.missingEmptyState",
      severity: rule.severity,
      title: "Empty state may be missing",
      message:
        "The component uses TanStack Query but no recognized empty-state handling was found.",
      recommendation:
        "Show an empty-state component or message when the returned collection has no records.",
      file,
      confidence: "medium",
    }),
  );
}

function detectHookWithoutTanstackQuery({
  file,
  source,
  config,
  findings,
}) {
  if (!isHookFile(file, config) || !hasApiRequest(source)) {
    return;
  }

  if (TANSTACK_QUERY_PATTERN.test(source)) {
    return;
  }

  const rule =
    config.hooks?.rules?.serverStateWithoutTanstackQuery;

  if (!rule?.enabled) {
    return;
  }

  findings.push(
    createFinding({
      ruleId: "fetching.serverStateWithoutTanstackQuery",
      severity: rule.severity,
      title: "Server-state hook may not use TanStack Query",
      message:
        "A hook performs an API request without a recognized TanStack Query hook.",
      recommendation:
        "Use useQuery, useMutation, or another appropriate TanStack Query API unless there is a documented exception.",
      file,
      confidence: "medium",
    }),
  );
}

/**
 * Runs frontend fetching and request-state checks.
 *
 * @param {object} options
 * @param {string} options.repositoryRoot
 * @param {string[]} options.files
 * @param {object} options.config
 * @returns {Promise<object[]>}
 */
export async function detectFetching({
  repositoryRoot,
  files,
  config,
}) {
  const findings = [];

  if (!config.fetching?.enabled) {
    return findings;
  }

  for (const relativeFile of files) {
    const extension = path.extname(relativeFile).toLowerCase();

    if (!SOURCE_EXTENSIONS.has(extension)) {
      continue;
    }

    if (isIgnored(relativeFile, config)) {
      continue;
    }

    if (isGeneratedFile(relativeFile, config)) {
      continue;
    }

    const absoluteFile = path.resolve(repositoryRoot, relativeFile);

    if (!fs.existsSync(absoluteFile)) {
      continue;
    }

    const source = fs.readFileSync(absoluteFile, "utf8");

    detectFetchUsage({
      file: relativeFile,
      source,
      config,
      findings,
    });

    detectDirectAxiosInUi({
      file: relativeFile,
      source,
      config,
      findings,
    });

    detectApiCallOutsideServiceLayer({
      file: relativeFile,
      source,
      config,
      findings,
    });

    detectMissingLoadingState({
      file: relativeFile,
      source,
      config,
      findings,
    });

    detectMissingErrorState({
      file: relativeFile,
      source,
      config,
      findings,
    });

    detectMissingEmptyState({
      file: relativeFile,
      source,
      config,
      findings,
    });

    detectHookWithoutTanstackQuery({
      file: relativeFile,
      source,
      config,
      findings,
    });
  }

  return findings;
}

export default detectFetching;