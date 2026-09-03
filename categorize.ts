// Parsing free-form Telegram messages into expenses, and auto-categorization.

export const CATEGORY_KEYWORDS: Record<string, string[]> = {
  "Еда": ["кофе", "обед", "ужин", "завтрак", "продукты", "ресторан", "кафе", "пицца", "суши", "еда", "перекус", "бургер", "столовая", "доставка", "супермаркет"],
  "Транспорт": ["такси", "метро", "автобус", "бензин", "заправка", "парковка", "каршеринг", "электричка", "поезд", "самолет", "самолёт", "авиабилет", "маршрутка", "проезд", "uber", "яндекс.такси"],
  "Дом": ["аренда", "квартира", "коммуналка", "свет", "жкх", "ремонт", "мебель", "хозтовары"],
  "Здоровье": ["аптека", "лекарства", "врач", "стоматолог", "больница", "витамины", "анализы", "клиника"],
  "Развлечения": ["кино", "бар", "концерт", "игра", "подписка", "netflix", "спортзал", "фитнес", "боулинг", "театр", "spotify"],
  "Одежда": ["одежда", "обувь", "куртка", "джинсы", "футболка", "кроссовки", "платье"],
  "Связь": ["телефон", "связь", "мобильный", "интернет", "симка", "sim"],
  "Образование": ["курс", "книга", "книги", "обучение", "лекция", "учебник"],
};

export const CATEGORY_NAMES = [...Object.keys(CATEGORY_KEYWORDS), "Прочее"];

const CATEGORY_ALIASES: Record<string, string> = {};
for (const name of CATEGORY_NAMES) CATEGORY_ALIASES[name.toLowerCase()] = name;
Object.assign(CATEGORY_ALIASES, {
  "еду": "Еда",
  "продукты": "Еда",
  "транспорте": "Транспорт",
  "дом": "Дом",
  "здоровье": "Здоровье",
  "развлечения": "Развлечения",
  "одежду": "Одежда",
  "связь": "Связь",
  "образование": "Образование",
  "прочее": "Прочее",
  "другое": "Прочее",
});

export function detectCategory(description: string): string {
  const lower = description.toLowerCase();
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const w of words) {
      if (lower.includes(w)) return cat;
    }
  }
  return "Прочее";
}

export function resolveExplicitCategory(word: string): string | null {
  const lower = word.toLowerCase().replace(/[.,!?]+$/, "");
  return CATEGORY_ALIASES[lower] ?? null;
}

export interface ParsedExpense {
  amount: number;
  currency: string;
  description: string;
  category: string;
}

// "кофе 350" | "такси 900 работа" | "350 кофе" | "обед 540 еда"
export function parseExpenseMessage(text: string): ParsedExpense | null {
  const raw = text.trim();
  const tokens = raw.split(/\s+/).filter(Boolean);
  let amountIdx = -1;
  let amount: number | null = null;
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
  if (amountIdx === -1 || amount === null) return null;

  const before = tokens.slice(0, amountIdx);
  const after = tokens.slice(amountIdx + 1);

  let description: string;
  let categoryTokens: string[];
  if (before.length > 0) {
    description = before.join(" ");
    categoryTokens = after;
  } else {
    description = after.join(" ") || "Без описания";
    categoryTokens = [];
  }

  let category: string | null = null;
  if (categoryTokens.length > 0) {
    category =
      resolveExplicitCategory(categoryTokens.join(" ")) ||
      resolveExplicitCategory(categoryTokens[categoryTokens.length - 1]);
  }
  if (!category) category = detectCategory(description);

  return { amount, currency, description, category };
}
