import fs from "node:fs";
import { chromium } from "playwright";

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
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return `${map.year}-${map.month}-${map.day}`;
}

async function openLoginForm(page, crmBaseUrl) {
  const loginUrl = `${crmBaseUrl}/Pages/Login.aspx`;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    console.log(`Opening CRM login page (attempt ${attempt}/5)...`);

    await page.goto(loginUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForTimeout(1000);

    const email = page.getByPlaceholder("Email address");
    const password = page.getByPlaceholder("Password");
    const loginButton = page.locator("#btnLogin");

    if (
      (await email.count()) > 0 &&
      (await password.count()) > 0 &&
      (await loginButton.count()) > 0 &&
      (await email.first().isVisible()) &&
      (await password.first().isVisible()) &&
      (await loginButton.first().isVisible())
    ) {
      console.log("CRM login form is ready.");

      return {
        email: email.first(),
        password: password.first(),
        loginButton: loginButton.first(),
      };
    }

    await page.waitForTimeout(1500);
  }

  throw new Error("CRM login form did not become ready after 5 attempts.");
}

async function loginToCrm(page, crmBaseUrl, username, password) {
  const form = await openLoginForm(page, crmBaseUrl);

  await form.email.fill(username);
  await form.password.fill(password);

  console.log("Submitting CRM login...");
  await form.loginButton.click();

  await page.waitForURL(
    (url) => !url.pathname.toLowerCase().endsWith("/login.aspx"),
    { timeout: 30000 },
  );

  if (page.url().toLowerCase().includes("login.aspx")) {
    throw new Error("CRM login failed.");
  }

  console.log(`CRM login successful: ${page.url()}`);
}

async function chooseAutocomplete(page, input, value) {
  await input.fill("");
  await input.fill(value);

  await page.waitForTimeout(900);

  const menu = page.locator(".ui-autocomplete:visible");
  await menu.waitFor({
    state: "visible",
    timeout: 15000,
  });

  const exact = menu
    .locator(".ui-menu-item")
    .filter({
      hasText: value,
    })
    .first();

  if ((await exact.count()) > 0) {
    await exact.click();
    return;
  }

  const first = menu.locator(".ui-menu-item").first();

  if ((await first.count()) === 0) {
    throw new Error(`Autocomplete returned no result for "${value}".`);
  }

  await first.click();
}


async function resolveSystemCode(page, wantedCode, wantedName) {
  const result = await page.evaluate(
    async ({ wantedCode, wantedName }) => {
      const response = await fetch(
        "/Pages/helpdesk.aspx/SystemRequestCodeList",
        {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            prefix: wantedCode,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(
          `SystemRequestCodeList HTTP ${response.status}`,
        );
      }

      const envelope = await response.json();

      let body = envelope?.d ?? envelope;

      if (typeof body === "string") {
        body = JSON.parse(body);
      }

      if (!body || body.status !== "success") {
        throw new Error(
          body?.message || "SystemRequestCodeList failed.",
        );
      }

      const items = Array.isArray(body.data)
        ? body.data
        : [];

      return (
        items.find(
          (item) =>
            String(item.Code || "").trim() === wantedCode,
        ) ||
        items.find(
          (item) =>
            String(item.Name || "").trim().toLowerCase() ===
            wantedName.toLowerCase(),
        ) ||
        null
      );
    },
    {
      wantedCode,
      wantedName,
    },
  );

  if (!result) {
    throw new Error(
      `CRM system "${wantedCode} - ${wantedName}" was not found.`,
    );
  }

  return result;
}

async function setSystemFields(page, row, fixed) {
  const system = await resolveSystemCode(
    page,
    "test",
    fixed.systemName,
  );

  if (
    String(system.Code || "").trim() !== fixed.systemCode ||
    String(system.Name || "").trim() !== fixed.systemName
  ) {
    throw new Error(
      `Unexpected CRM system result: ${JSON.stringify(system)}`,
    );
  }

  const systemName = row.locator(
    '[id*="txtSystemName_Entry_"]',
  );
  const systemCode = row.locator(
    '[id*="txtSystemCode_Entry_"]',
  );
  const systemCodeId = row.locator(
    '[id*="txtSystemCodeID_Entry_"]',
  );

  // These values are normally assigned by the CRM autocomplete select
  // callback. System Code is readonly, so assign through DOM properties
  // and dispatch change/input events instead of Playwright fill().
  await systemName.evaluate(
    (element, value) => {
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    },
    String(system.Name),
  );

  await systemCode.evaluate(
    (element, value) => {
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    },
    String(system.Code),
  );

  if ((await systemCodeId.count()) === 0) {
    throw new Error(
      "CRM hidden System Code ID field was not found.",
    );
  }

  await systemCodeId.evaluate(
    (element, value) => {
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    },
    String(system.RecordID),
  );

  const selectedCode = (await systemCode.inputValue()).trim();
  const selectedName = (await systemName.inputValue()).trim();
  const selectedId = (await systemCodeId.inputValue()).trim();

  if (
    selectedCode !== fixed.systemCode ||
    selectedName !== fixed.systemName ||
    selectedId !== String(system.RecordID)
  ) {
    throw new Error(
      `CRM system fields did not bind correctly. Code="${selectedCode}", Name="${selectedName}", RecordID="${selectedId}".`,
    );
  }

  console.log(
    `System resolved: ${selectedCode} - ${selectedName} (RecordID ${selectedId})`,
  );
}
function ticketRows(page) {
  return page.locator("tr").filter({
    has: page.locator('[id*="txtConcern_Entry_"]'),
  });
}

async function addRow(page, expectedCount) {
  const addButton = page.locator("#MainContent_dgvEntry_btnAdd_Entry").first();

  await addButton.waitFor({ state: "visible", timeout: 30000 });

  if (!(await addButton.isEnabled())) {
    throw new Error(
      `CRM Add Entry button is disabled while waiting for row ${expectedCount}.`,
    );
  }

  console.log(`Adding CRM row ${expectedCount}...`);
  await addButton.click({ timeout: 30000 });

  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('[id*="txtConcern_Entry_"]').length >= count,
    expectedCount,
    { timeout: 60000 },
  );
}

async function fillTicketRow(page, row, ticket, fixed) {
  const type = row.locator('[id*="ddlType_"]');

  await type.selectOption({
    label: fixed.type,
  }).catch(async () => {
    await type.selectOption(fixed.type);
  });

  const client = row.locator('[id*="txtClientName_Entry_"]');
  await chooseAutocomplete(page, client, fixed.clientName);

  await row
    .locator('[id*="txtModule_Entry_"]')
    .fill(ticket.module || "QA");

  await row
    .locator('[id*="txtConcern_Entry_"]')
    .fill(ticket.concern);

  const inCharge = row.locator('[id*="txtInchargeName_Entry_"]');
  await chooseAutocomplete(page, inCharge, fixed.inChargeName);

  const startDate = row.locator('[id*="txtStartDate_Entry_"]');
  if ((await startDate.count()) > 0) {
    await startDate.fill(fixed.date);
  }

  const targetDate = row.locator('[id*="txtTargetDate_Entry_"]');
  if ((await targetDate.count()) > 0) {
    await targetDate.fill(fixed.date);
  }

  await setSystemFields(page, row, fixed);

  const status = row.locator('[id*="ddlStatus_"]');
  if ((await status.count()) > 0) {
    await status.selectOption({
      label: fixed.status,
    }).catch(async () => {
      await status.selectOption(fixed.status);
    });
  }

  const remoteId = row.locator('[id*="txtRemoteID_Entry_"]');
  if ((await remoteId.count()) > 0) {
    const source =
      ticket.file ||
      ticket.ruleId ||
      ticket.kind ||
      "ticket";

    await remoteId.fill(
      [
        fixed.repository,
        fixed.headSha,
        ticket.kind,
        source,
      ]
        .join("|")
        .slice(0, 190),
    );
  }
}

const inputFile = process.argv[2];

if (!inputFile) {
  throw new Error(
    "Usage: node publish-crm-tickets.mjs <crm-tickets.json>",
  );
}

const payload = readJson(inputFile);

const tickets = Array.isArray(payload.tickets)
  ? payload.tickets
  : [];

if (tickets.length === 0) {
  console.log("No CRM tickets to create.");
  process.exit(0);
}

const maxTickets = Number(
  process.env.CRM_MAX_TICKETS || "200",
);

if (tickets.length > maxTickets) {
  console.warn(
    `Skipping CRM publishing: ${tickets.length} tickets exceed CRM_MAX_TICKETS=${maxTickets}. ` +
      "No CRM tickets were submitted; the generated payload remains available for review.",
  );
  process.exit(0);
}

const crmBaseUrl = "https://crm.integr8.com.ph:6711";
const crmUsername = "gmenciano@integr8.com.ph";
const crmPassword = "12345";

const dryRun =
  String(
    process.env.CRM_DRY_RUN || "true",
  ).toLowerCase() !== "false";

const fixed = {
  type: "Task",
  clientName: "Integr8 Software Solutions Inc.",
  inChargeName: "Menciano, Gil B.",
  systemCode: "99001",
  systemName: "Ticket/Task Testing",
  status: "On-Going",
  date: manilaDate(),
  repository: payload.source?.repository || "",
  headSha: payload.source?.headSha || "",
};

const browser = await chromium.launch({
  headless: true,
});

const context = await browser.newContext();

try {
  const page = await context.newPage();

  await loginToCrm(page, crmBaseUrl, crmUsername, crmPassword);

  // The CRM Add Entry control is unreliable after page updates.
  // Publish one ticket per Help Desk form so the existing first row is used
  // and no Add Entry click is required. This favors reliability over speed.
  const batchSize = 1;
  const totalBatches = Math.ceil(tickets.length / batchSize);
  let submittedTotal = 0;

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex += 1) {
    const batchStart = batchIndex * batchSize;
    const batch = tickets.slice(batchStart, batchStart + batchSize);

    console.log(
      `Opening Help Desk for batch ${batchIndex + 1}/${totalBatches}...`,
    );

    await page.goto(`${crmBaseUrl}/Pages/helpdesk.aspx`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.locator("#MainContent_dgvEntry_ddlType_0").waitFor({
      state: "visible",
      timeout: 30000,
    });

    let rows = ticketRows(page);
    let rowCount = await rows.count();

    if (rowCount === 0) {
      throw new Error("No Help Desk entry row was found.");
    }

    for (
      let batchTicketIndex = 0;
      batchTicketIndex < batch.length;
      batchTicketIndex += 1
    ) {
      rows = ticketRows(page);
      rowCount = await rows.count();

      while (rowCount <= batchTicketIndex) {
        await addRow(page, rowCount + 1);
        rows = ticketRows(page);
        rowCount = await rows.count();
      }

      const ticket = batch[batchTicketIndex];
      const globalIndex = batchStart + batchTicketIndex;

      console.log(
        `[${globalIndex + 1}/${tickets.length}] ` +
          `${ticket.module}: ${ticket.concern}`,
      );

      await fillTicketRow(
        page,
        rows.nth(batchTicketIndex),
        ticket,
        fixed,
      );
    }

    console.log(
      `Prepared ${batch.length} CRM ticket row(s) for batch ` +
        `${batchIndex + 1}/${totalBatches}.`,
    );

    if (dryRun) {
      console.log(
        `CRM_DRY_RUN=true — batch ${batchIndex + 1}/${totalBatches} was not submitted.`,
      );
      continue;
    }

    console.log(
      `Submitting CRM batch ${batchIndex + 1}/${totalBatches}...`,
    );

    const submit = page.locator("#MainContent_btnSave");

    await submit.waitFor({
      state: "visible",
      timeout: 30000,
    });

    await submit.click({ timeout: 30000 });
    await page.waitForTimeout(3000);

    submittedTotal += batch.length;

    console.log(
      `Submitted ${batch.length} CRM ticket(s) in batch ` +
        `${batchIndex + 1}/${totalBatches}. Total submitted: ` +
        `${submittedTotal}/${tickets.length}.`,
    );
  }

  if (dryRun) {
    console.log(
      `CRM_DRY_RUN=true — prepared ${tickets.length} ticket(s) across ` +
        `${totalBatches} batch(es); nothing was submitted.`,
    );
  } else {
    console.log(
      `Submitted ${submittedTotal} CRM ticket(s) across ` +
        `${totalBatches} batch(es).`,
    );
  }

} finally {
  await context.close();
  await browser.close();
}