const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (msg) => { if (msg.type() === "error") errors.push("console.error: " + msg.text()); });

  const fixtures = {
    "/api/me": { telegram_id: 1, first_name: "Аня", username: "anya" },
    "/api/categories": ["Еда", "Транспорт", "Дом", "Здоровье", "Развлечения", "Одежда", "Связь", "Образование", "Прочее"],
    "/api/summary?period=month": {
      period: "month",
      totals_by_currency: { RUB: 1250 },
      by_category: [
        { category: "Еда", total: 900, currency: "RUB", limit: 15000 },
        { category: "Транспорт", total: 350, currency: "RUB", limit: null },
      ],
      count: 2,
    },
    "/api/expenses?period=month": [
      { id: 1, amount: 900, currency: "RUB", description: "обед", category: "Еда", spent_at: "2026-09-03" },
      { id: 2, amount: 350, currency: "RUB", description: "такси", category: "Транспорт", spent_at: "2026-09-02" },
    ],
  };

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const key = u.pathname.replace(/^\/tmp\/panel\.html\//, "/") + (u.search || "");
    const shortKey = "/" + key.split("/").slice(-1)[0] === "" ? key : key; // fallback
    let match = fixtures[key];
    if (!match) {
      // try matching by suffix (pathname endsWith)
      for (const k of Object.keys(fixtures)) {
        if (req.url().endsWith(k)) { match = fixtures[k]; break; }
      }
    }
    if (match) {
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(match) });
    } else {
      route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    }
  });

  await page.goto("file:///tmp/panel.html", { waitUntil: "load" });
  await page.waitForTimeout(800);

  const totalText = await page.textContent(".total");
  console.log("total shown:", totalText);
  const expenseCount = await page.$$eval(".expense", (els) => els.length);
  console.log("expense rows:", expenseCount);

  // open add-expense modal
  await page.click(".fab");
  await page.waitForTimeout(200);
  const modalVisible = await page.$eval("#modalBg", (el) => el.classList.contains("show"));
  console.log("add modal visible:", modalVisible);

  // switch tab
  await page.click('.tab[data-p="today"]');
  await page.waitForTimeout(300);

  console.log("errors:", JSON.stringify(errors, null, 2));
  await browser.close();
})();
