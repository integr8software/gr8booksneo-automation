import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx"
]);

export function getChangedFiles(options = {}) {
  const {
    repositoryRoot = process.cwd(),
    baseReference,
    headReference = "HEAD",
    extensions = DEFAULT_EXTENSIONS,
    ignoredDirectories = [],
  } = options;

  let files = [];

  try {
    if (baseReference) {
      const output = execSync(
        `git diff --name-only ${baseReference} ${headReference}`,
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }
      );

      files = output
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);
    } else {
      const output = execSync(
        "git diff --cached --name-only",
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }
      );

      files = output
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);
    }
  } catch {
    return [];
  }

  return files
    .filter(file => {
      const ext = path.extname(file);
      return extensions.has(ext);
    })
    .filter(file => {
      return !ignoredDirectories.some(dir =>
        file.startsWith(dir)
      );
    })
    .filter(file => {
      return fs.existsSync(
        path.join(repositoryRoot, file)
      );
    })
    .sort();
}

export function isSourceFile(file) {
  return DEFAULT_EXTENSIONS.has(path.extname(file));
}

export function groupFilesByDirectory(files) {
  const groups = {};

  for (const file of files) {
    const dir = path.dirname(file);

    if (!groups[dir]) {
      groups[dir] = [];
    }

    groups[dir].push(file);
  }

  return groups;
}

export function summarizeChangedFiles(files) {
  return {
    total: files.length,
    ts: files.filter(f => f.endsWith(".ts")).length,
    tsx: files.filter(f => f.endsWith(".tsx")).length,
    js: files.filter(f => f.endsWith(".js")).length,
    jsx: files.filter(f => f.endsWith(".jsx")).length,
  };
}