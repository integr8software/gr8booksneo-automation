import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function manilaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const map = Object.fromEntries(
    parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );

  return `${map.year}-${map.month}-${map.day}`;
}

async function chooseAutocomplete(page, input, value) {
  await input.fill("");
  await input.fill(value);
  await page.waitForTimeout(700);

  const item = page.locator(".ui-autocomplete:visible .ui-menu-item").first();
  await item.waitFor({ state: "visible", timeout: 15000 });
  await item.click();
}

async function ticketRows(page) {
  return page.locator("tr").filter({
    has: page.locator('[id$="txtConcern_Entry"]'),
  });
}

async function addRow(page, expectedCount) {
  const addButton = page.getByRole("button", { name: /add entry/i }).first();

  if ((await addButton.count()) === 0) {
    throw new Error("Add Entry button was not found.");
  }

  await addButton.click();

  await page.waitForFunction(
    ({ expectedCount }) => {
      return document.querySelectorAll('[id$="txtConcern_Entry"]').length >= expectedCount;
    },
    { expectedCount },
    { timeout: 20000 },
  );
}

async function fillTicketRow(page, row, ticket, fixed) {
  const type = row.locator('[id$="ddlType"]');
  if ((await type.count()) > 0) {
    await type.selectOption({ label: fixed.type }).catch(async () => {
      await type.selectOption(fixed.type);
    });
  }

  const client = row.locator('[id$="txtClientName_Entry"]');
  await chooseAutocomplete(page, client, fixed.clientName);

  await row.locator('[id$="txtModule_Entry"]').fill(ticket.module || "QA");
  await row.locator('[id$="txtConcern_Entry"]').fill(ticket.concern);

  const inCharge = row.locator('[id$="txtInchargeName_Entry"]');
  await chooseAutocomplete(page, inCharge, fixed.inChargeName);

  const startDate = row.locator('[id$="txtStartDate_Entry"]');
  if ((await startDate.count()) > 0) await startDate.fill(fixed.date);

  const targetDate = row.locator('[id$="txtTargetDate_Entry"]');
  if ((await targetDate.count()) > 0) await targetDate.fill(fixed.date);

  const systemName = row.locator('[id$="txtSystemName_Entry"]');
  await chooseAutocomplete(page, systemName, fixed.systemName);

  const status = row.locator('[id$="ddlStatus"]');
  if ((await status.count()) > 0) {
    await status.selectOption({ label: fixed.status }).catch(async () => {
      await status.selectOption(fixed.status);
    });
  }

  const remoteId = row.locator('[id$="txtRemoteID_Entry"]');
  if ((await remoteId.count()) > 0) {
    const source = ticket.file || ticket.ruleId || ticket.kind || "ticket";
    await remoteId.fill(
      `${fixed.repository}|${fixed.headSha}|${ticket.kind}|${source}`.slice(0, 190),
    );
  }
}

const inputFile = process.argv[2];
if (!inputFile) {
  throw new Error("Usage: node publish-crm-tickets.mjs <crm-tickets.json>");
}

const payload = readJson(inputFile);
const tickets = Array.isArray(payload.tickets) ? payload.tickets : [];

if (tickets.length === 0) {
  console.log("No CRM tickets to create.");
  process.exit(0);
}

const maxTickets = Number(process.env.CRM_MAX_TICKETS || "200");
if (tickets.length > maxTickets) {
  throw new Error(
    `Refusing to submit ${tickets.length} tickets because CRM_MAX_TICKETS=${maxTickets}.`,
  );
}

const crmBaseUrl = requiredEnv("CRM_BASE_URL").replace(/\/+$/, "");
const crmUsername = requiredEnv("CRM_USERNAME");
const crmPassword = requiredEnv("CRM_PASSWORD");
const dryRun = String(process.env.CRM_DRY_RUN || "true").toLowerCase() !== "false";

const fixed = {
  type: "Task",
  clientName: "Integr8 Software Solutions Inc.",
  inChargeName: "Menciano, Gil B.",
  systemName: "Ticket/Task Testing",
  status: "On-Going",
  date: manilaDate(),
  repository: payload.source?.repository || "",
  headSha: payload.source?.headSha || "",
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();

try {
  const page = await context.newPage();

  await page.goto(`${crmBaseUrl}/pages/Login.aspx`, {
    waitUntil: "domcontentloaded",
  });

  await page.locator('[id$="txtEmail"]').fill(crmUsername);
  await page.locator('[id$="txtPassword"]').fill(crmPassword);

  await Promise.all([
    page.waitForLoadState("domcontentloaded"),
    page.locator('[id$="btnLogin"]').click(),
  ]);

  if (page.url().toLowerCase().includes("login.aspx")) {
    throw new Error("CRM login failed.");
  }

  await page.goto(`${crmBaseUrl}/pages/helpdesk.aspx`, {
    waitUntil: "domcontentloaded",
  });

  let rows = await ticketRows(page);
  let rowCount = await rows.count();

  if (rowCount === 0) {
    throw new Error("No Help Desk entry row was found.");
  }

  for (let i = 0; i < tickets.length; i += 1) {
    rows = await ticketRows(page);
    rowCount = await rows.count();

    while (rowCount <= i) {
      await addRow(page, rowCount + 1);
      rows = await ticketRows(page);
      rowCount = await rows.count();
    }

    console.log(`[${i + 1}/${tickets.length}] ${tickets[i].module}: ${tickets[i].concern}`);
    await fillTicketRow(page, rows.nth(i), tickets[i], fixed);
  }

  const proofDir = path.join(path.dirname(inputFile), "proof");
  fs.mkdirSync(proofDir, { recursive: true });

  const proofPath = path.join(
    proofDir,
    `${(fixed.headSha || "crm").slice(0, 12)}-${dryRun ? "dry-run" : "before-submit"}.png`,
  );

  await page.screenshot({
    path: proofPath,
    fullPage: true,
  });

  console.log(`Prepared ${tickets.length} CRM ticket row(s).`);
  console.log(`Proof: ${proofPath}`);

  if (dryRun) {
    console.log("CRM_DRY_RUN=true — no tickets were submitted.");
    process.exit(0);
  }

  const save = page.locator('[id$="btnSave"]').first();
  await save.waitFor({ state: "visible", timeout: 15000 });
  await save.click();

  await page.waitForTimeout(3000);

  console.log(`Submitted ${tickets.length} CRM ticket(s).`);
} finally {
  await context.close();
  await browser.close();
}