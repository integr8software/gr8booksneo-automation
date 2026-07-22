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
    headless: true
});

try {

    const page = await browser.newPage({
        viewport: {
            width: 1360,
            height: 900
        }
    });

    console.log("[INFO] Opening dashboard...");

    await page.goto(pathToFileURL(htmlPath).href, {
        waitUntil: "networkidle"
    });

    console.log("[INFO] Waiting for dashboard...");

    await page.waitForSelector(".app-window", {
        timeout: 15000
    });

    console.log("[INFO] Taking screenshot...");

    const dashboard = page.locator(".app-window");

    await dashboard.screenshot({
        path: pngPath,
        animations: "disabled"
    });

    console.log("[SUCCESS] Screenshot created.");

}
catch (err) {

    console.error("[ERROR]");
    console.error(err);

    process.exit(1);

}
finally {

    await browser.close();

}