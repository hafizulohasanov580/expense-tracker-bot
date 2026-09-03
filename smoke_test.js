const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push("console.error: " + msg.text());
  });
  await page.goto("file:///tmp/panel.html", { waitUntil: "load" });
  await page.waitForTimeout(1000);
  const rootText = await page.textContent("#root");
  console.log("root text after boot:", JSON.stringify(rootText).slice(0, 200));
  console.log("errors:", JSON.stringify(errors, null, 2));
  await browser.close();
})();
