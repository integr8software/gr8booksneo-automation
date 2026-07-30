import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const htmlPath = resolve(process.argv[2] ?? "reports/QA-Report.html");
const pngPath = resolve(process.argv[3] ?? "reports/QA-Report.png");

console.log(`[INFO] HTML input : ${htmlPath}`);
console.log(`[INFO] PNG output : ${pngPath}`);

if (!existsSync(htmlPath)) {
    console.error(`[ERROR] HTML report not found: ${htmlPath}`);
    process.exit(1);
}

await mkdir(dirname(pngPath), { recursive: true });

const browser = await chromium.launch({
    headless: true,
});

try {
    const page = await browser.newPage({
        viewport: {
            width: 1600,
            height: 900,
        },
    });

    page.on("console", (message) => {
        console.log(`[BROWSER ${message.type().toUpperCase()}] ${message.text()}`);
    });

    page.on("pageerror", (error) => {
        console.error(`[BROWSER ERROR] ${error.message}`);
    });

    console.log("[INFO] Opening dashboard...");

    await page.goto(pathToFileURL(htmlPath).href, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
    });

    console.log("[INFO] Waiting for dashboard element...");

    const dashboard = page.locator(".app-window");

    await dashboard.waitFor({
        state: "attached",
        timeout: 60_000,
    });

    await page.waitForTimeout(1_000);

    const box = await dashboard.boundingBox();

    if (!box || box.width <= 0 || box.height <= 0) {
        throw new Error(
            "Dashboard element exists but has no visible dimensions."
        );
    }

    console.log(
        `[INFO] Dashboard size: ${Math.round(box.width)}x${Math.round(box.height)}`
    );

    console.log("[INFO] Taking screenshot...");

    await dashboard.screenshot({
        path: pngPath,
        animations: "disabled",
        timeout: 60_000,
    });

    console.log("[SUCCESS] Screenshot created.");
} catch (error) {
    console.error("[ERROR] Dashboard screenshot generation failed.");

    if (error instanceof Error) {
        console.error(error.stack ?? error.message);
    } else {
        console.error(error);
    }

    process.exitCode = 1;
} finally {
    await browser.close();
}