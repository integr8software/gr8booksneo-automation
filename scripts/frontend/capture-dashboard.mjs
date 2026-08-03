import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const CURRENT_DIRECTORY = path.dirname(CURRENT_FILE);

const AUTOMATION_ROOT = path.resolve(
  CURRENT_DIRECTORY,
  "../..",
);

const DEFAULT_HTML_PATH = path.join(
  AUTOMATION_ROOT,
  "reports",
  "Frontend-QA-Report.html",
);

const DEFAULT_OUTPUT_PATH = path.join(
  AUTOMATION_ROOT,
  "reports",
  "Frontend-QA-Report.png",
);

function parseArguments(values) {
  const options = {
    htmlPath: DEFAULT_HTML_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    width: 1440,
    height: 1200,
    fullPage: true,
    timeout: 30000,
    help: false,
  };

  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];

    switch (argument) {
      case "--html":
      case "--input":
        options.htmlPath =
          values[index + 1] ?? options.htmlPath;
        index += 1;
        break;

      case "--output":
        options.outputPath =
          values[index + 1] ?? options.outputPath;
        index += 1;
        break;

      case "--width":
        options.width = Number(
          values[index + 1],
        );
        index += 1;
        break;

      case "--height":
        options.height = Number(
          values[index + 1],
        );
        index += 1;
        break;

      case "--timeout":
        options.timeout = Number(
          values[index + 1],
        );
        index += 1;
        break;

      case "--viewport-only":
        options.fullPage = false;
        break;

      case "--full-page":
        options.fullPage = true;
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
Frontend QA Dashboard Capture

Usage:
  node scripts/frontend/capture-dashboard.mjs [options]

Options:
  --html <path>       HTML report input
  --output <path>     PNG output path
  --width <number>    Browser viewport width
  --height <number>   Browser viewport height
  --timeout <number>  Navigation timeout in milliseconds
  --full-page         Capture the entire report
  --viewport-only     Capture viewport only
  --help              Show this help
`);
}

function resolvePath(value) {
  return path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(AUTOMATION_ROOT, value);
}

function validatePositiveNumber(
  value,
  optionName,
) {
  if (
    !Number.isFinite(value) ||
    value <= 0
  ) {
    throw new Error(
      `${optionName} must be a positive number.`,
    );
  }
}

export async function captureDashboard(
  suppliedOptions = {},
) {
  const options = {
    ...parseArguments([]),
    ...suppliedOptions,
  };

  const htmlPath = resolvePath(
    options.htmlPath,
  );

  const outputPath = resolvePath(
    options.outputPath,
  );

  validatePositiveNumber(
    options.width,
    "--width",
  );

  validatePositiveNumber(
    options.height,
    "--height",
  );

  validatePositiveNumber(
    options.timeout,
    "--timeout",
  );

  if (!fs.existsSync(htmlPath)) {
    throw new Error(
      `Frontend HTML report was not found: ${htmlPath}`,
    );
  }

  fs.mkdirSync(
    path.dirname(outputPath),
    {
      recursive: true,
    },
  );

  if (fs.existsSync(outputPath)) {
    fs.rmSync(outputPath, {
      force: true,
    });
  }

  const browser = await chromium.launch({
    headless: true,
  });

  try {
    const page = await browser.newPage({
      viewport: {
        width: Math.round(options.width),
        height: Math.round(options.height),
      },
      deviceScaleFactor: 1,
    });

    page.setDefaultTimeout(
      options.timeout,
    );

    page.setDefaultNavigationTimeout(
      options.timeout,
    );

    const fileUrl =
      pathToFileURL(htmlPath).href;

    await page.goto(fileUrl, {
      waitUntil: "networkidle",
      timeout: options.timeout,
    });

    await page.evaluate(async () => {
      if (document.fonts?.ready) {
        await document.fonts.ready;
      }
    });

    await page.screenshot({
      path: outputPath,
      fullPage: options.fullPage,
      type: "png",
      animations: "disabled",
    });
  } finally {
    await browser.close();
  }

  const statistics = fs.statSync(
    outputPath,
  );

  if (statistics.size === 0) {
    throw new Error(
      `Dashboard capture produced an empty PNG: ${outputPath}`,
    );
  }

  return {
    htmlPath,
    outputPath,
    bytes: statistics.size,
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

    const result =
      await captureDashboard(options);

    console.log("");
    console.log(
      "Frontend dashboard captured.",
    );
    console.log(
      `HTML   : ${result.htmlPath}`,
    );
    console.log(
      `PNG    : ${result.outputPath}`,
    );
    console.log(
      `Size   : ${result.bytes} bytes`,
    );
    console.log("");
  } catch (error) {
    console.error("");
    console.error(
      "Frontend dashboard capture failed.",
    );
    console.error(error.message);
    console.error("");

    process.exitCode = 1;
  }
}

const invokedFile = process.argv[1]
  ? path.resolve(process.argv[1])
  : "";

if (invokedFile === CURRENT_FILE) {
  await main();
}

export default captureDashboard;