// Local sanity test for the message-parsing / categorization logic
// (mirrors supabase/functions/app/categorize.ts, plain JS for quick node testing)

const CATEGORY_KEYWORDS = {
  "Еда": ["кофе","обед","ужин","завтрак","продукты","ресторан","кафе","пицца","суши","еда","перекус","бургер","столовая","доставка"],
  "Транспорт": ["такси","метро","автобус","бензин","заправка","парковка","каршеринг","электричка","поезд","самолет","авиабилет","маршрутка","проезд"],
  "Дом": ["аренда","квартира","коммуналка","свет","жкх","ремонт","мебель","хозтовары"],
  "Здоровье": ["аптека","лекарства","врач","стоматолог","больница","витамины","анализы"],
  "Развлечения": ["кино","бар","концерт","игра","подписка","netflix","спортзал","фитнес","боулинг","театр"],
  "Одежда": ["одежда","обувь","куртка","джинсы","футболка","кроссовки"],
  "Связь": ["телефон","связь","мобильный","интернет","симка"],
  "Образование": ["курс","книга","книги","обучение","лекция","учебник"],
};
const CATEGORY_NAMES = Object.keys(CATEGORY_KEYWORDS).concat(["Прочее"]);
const CATEGORY_ALIASES = {};
for (const name of CATEGORY_NAMES) CATEGORY_ALIASES[name.toLowerCase()] = name;
Object.assign(CATEGORY_ALIASES, {
  "еду": "Еда", "продукты": "Еда", "транспорте": "Транспорт", "дом": "Дом",
  "здоровье": "Здоровье", "развлечения": "Развлечения", "одежду": "Одежда",
  "связь": "Связь", "образование": "Образование", "прочее": "Прочее", "другое": "Прочее",
});

function detectCategory(description) {
  const lower = description.toLowerCase();
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const w of words) {
      if (lower.includes(w)) return cat;
    }
  }
  return "Прочее";
}

function resolveExplicitCategory(word) {
  const lower = word.toLowerCase().replace(/[.,!?]+$/, "");
  return CATEGORY_ALIASES[lower] || null;
}

function parseExpenseMessage(text) {
  const raw = text.trim();
  const tokens = raw.split(/\s+/).filter(Boolean);
  let amountIdx = -1;
  let amount = null;
  let currency = "RUB";
  for (let i = 0; i < tokens.length; i++) {
    const cleaned = tokens[i].replace(",", ".").replace(/[₽рrRUBруб.]+$/i, "");
    const n = Number(cleaned);
    if (!Number.isNaN(n) && n > 0 && /\d/.test(tokens[i])) {
      amount = Math.round(n * 100) / 100;
      amountIdx = i;
      if (/\$|usd/i.test(tokens[i])) currency = "USD";
      else if (/€|eur/i.test(tokens[i])) currency = "EUR";
      break;
    }
  }
  if (amountIdx === -1) return null;

  const before = tokens.slice(0, amountIdx);
  const after = tokens.slice(amountIdx + 1);

  let description, categoryTokens;
  if (before.length > 0) {
    description = before.join(" ");
    categoryTokens = after;
  } else {
    description = after.join(" ") || "Без описания";
    categoryTokens = [];
  }

  let category = null;
  if (categoryTokens.length > 0) {
    category = resolveExplicitCategory(categoryTokens.join(" ")) || resolveExplicitCategory(categoryTokens[categoryTokens.length - 1]);
  }
  if (!category) category = detectCategory(description);

  return { amount, currency, description, category };
}

const tests = [
  "кофе 350",
  "такси 900 работа",
  "350 кофе",
  "обед 540 еда",
  "аптека 1200",
  "netflix подписка 599",
  "1500 книги образование",
  "кроссовки 4990 одежда",
  "интернет 700",
  "просто трата без суммы",
  "заправка 2000р",
  "маме на день рождения 3000",
];

for (const t of tests) {
  console.log(JSON.stringify(t), "=>", JSON.stringify(parseExpenseMessage(t)));
}
