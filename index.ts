import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { pgSelect, pgInsert, pgUpdate, pgDelete, getSetting, setSetting } from "./db.ts";
import { sendMessage, answerCallbackQuery, editMessageReplyMarkup, setWebhook } from "./telegram.ts";
import { parseExpenseMessage, CATEGORY_NAMES, resolveExplicitCategory } from "./categorize.ts";
import { localDateStr, periodStart, parseCookies, randomToken, toCsv } from "./util.ts";
import { renderPanel } from "./render.ts";

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });
}

function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: { "Content-Type": "text/html; charset=utf-8", ...(init.headers || {}) },
  });
}

// Supabase's edge runtime terminates TLS in front of the function, so
// `req.url` / `url.origin` as seen inside the function can come back as
// plain http:// and without the `/functions/v1/<name>` prefix that the
// public internet actually needs. Deriving the panel's public base URL from
// the incoming request is unreliable, so it's hardcoded here instead.
const PUBLIC_BASE_URL = "https://stkevjznrrbcfvkxrxut.supabase.co/functions/v1/app";

const SESSION_COOKIE = "session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}
function clearCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

interface Session {
  telegram_id: number;
  first_name: string | null;
  username: string | null;
}

async function getSession(req: Request): Promise<Session | null> {
  const cookies = parseCookies(req.headers.get("cookie"));
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const rows = await pgSelect<{ telegram_id: number }>(
    "sessions",
    `token=eq.${encodeURIComponent(token)}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=telegram_id`,
  );
  if (!rows.length) return null;
  const users = await pgSelect<Session>(
    "users",
    `telegram_id=eq.${rows[0].telegram_id}&select=telegram_id,first_name,username`,
  );
  return users[0] ?? null;
}

// ---------------------------------------------------------------------------
// Telegram bot
// ---------------------------------------------------------------------------

async function upsertUser(from: { id: number; username?: string; first_name?: string }) {
  await pgInsert(
    "users",
    { telegram_id: from.id, username: from.username ?? null, first_name: from.first_name ?? null },
    { onConflict: "telegram_id" },
  );
}

async function issueLoginLink(botToken: string, panelUrl: string, telegramId: number): Promise<string> {
  const token = randomToken(20);
  await pgInsert("login_tokens", { token, telegram_id: telegramId });
  return `${panelUrl}?token=${token}`;
}

async function categorySummaryText(telegramId: number, period: "today" | "week" | "month"): Promise<string> {
  const today = localDateStr();
  const from = periodStart(period, today);
  const rows = await pgSelect<{ amount: number; currency: string; category: string }>(
    "expenses",
    `user_id=eq.${telegramId}&spent_at=gte.${from}&select=amount,currency,category`,
  );
  if (!rows.length) {
    return period === "today" ? "Сегодня трат ещё нет." : period === "week" ? "На этой неделе трат ещё нет." : "В этом месяце трат ещё нет.";
  }
  const totals: Record<string, number> = {};
  const byCat: Record<string, { total: number; currency: string }> = {};
  for (const r of rows) {
    totals[r.currency] = (totals[r.currency] ?? 0) + Number(r.amount);
    const key = `${r.category}__${r.currency}`;
    if (!byCat[key]) byCat[key] = { total: 0, currency: r.currency };
    byCat[key].total += Number(r.amount);
  }
  const title = period === "today" ? "Сегодня" : period === "week" ? "За неделю" : "За месяц";
  const totalLine = Object.entries(totals).map(([cur, v]) => fmt(v, cur)).join(", ");
  const catLines = Object.entries(byCat)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([key, v]) => `• ${key.split("__")[0]}: ${fmt(v.total, v.currency)}`)
    .join("\n");
  return `<b>${title}: ${totalLine}</b>\n\n${catLines}`;
}

function fmt(n: number, cur: string): string {
  const sym = cur === "USD" ? "$" : cur === "EUR" ? "€" : "₽";
  return `${n.toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ${sym}`;
}

async function checkBudgetWarning(telegramId: number, category: string, currency: string): Promise<string | null> {
  const budgets = await pgSelect<{ monthly_limit: number; currency: string }>(
    "budgets",
    `user_id=eq.${telegramId}&category=eq.${encodeURIComponent(category)}&select=monthly_limit,currency`,
  );
  const budget = budgets[0];
  if (!budget || budget.currency !== currency) return null;
  const today = localDateStr();
  const from = periodStart("month", today);
  const rows = await pgSelect<{ amount: number }>(
    "expenses",
    `user_id=eq.${telegramId}&category=eq.${encodeURIComponent(category)}&currency=eq.${currency}&spent_at=gte.${from}&select=amount`,
  );
  const total = rows.reduce((s, r) => s + Number(r.amount), 0);
  if (total >= budget.monthly_limit) {
    return `⚠️ Лимит по категории «${category}» исчерпан: ${fmt(total, currency)} из ${fmt(budget.monthly_limit, currency)} в этом месяце.`;
  }
  return null;
}

async function handleUpdate(update: any, botToken: string, panelUrl: string) {
  if (update.callback_query) {
    const cq = update.callback_query;
    const data: string = cq.data ?? "";
    const chatId = cq.message?.chat?.id;
    const messageId = cq.message?.message_id;
    if (data.startsWith("del:")) {
      const id = Number(data.slice(4));
      const deleted = await pgDelete("expenses", `id=eq.${id}&user_id=eq.${cq.from.id}`);
      if (deleted.length) {
        await answerCallbackQuery(botToken, cq.id, "Удалено");
        if (chatId && messageId) await editMessageReplyMarkup(botToken, chatId, messageId, null);
      } else {
        await answerCallbackQuery(botToken, cq.id, "Не найдено (уже удалено?)");
      }
    } else {
      await answerCallbackQuery(botToken, cq.id);
    }
    return;
  }

  const msg = update.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const from = msg.from;
  await upsertUser(from);

  const text: string = msg.text.trim();

  if (text.startsWith("/")) {
    const [cmdRaw, ...rest] = text.split(/\s+/);
    const cmd = cmdRaw.replace(/@\w+$/, "").toLowerCase();
    const argText = rest.join(" ");

    if (cmd === "/start") {
      const link = await issueLoginLink(botToken, panelUrl, from.id);
      await sendMessage(
        botToken,
        chatId,
        "👋 Привет! Я помогу считать твои траты.\n\n" +
          "Просто напиши сумму и что купил, например:\n<code>кофе 350</code>\n<code>такси 900 работа</code>\n\n" +
          "Категория определится сама, но её можно указать словом в конце сообщения.\n\n" +
          "Команды: /today /week /month — итоги, /panel — открыть веб-панель, /last — последние траты, /limit — лимит по категории, /help — помощь.",
        { buttons: [[{ text: "📊 Открыть панель", url: link }]] },
      );
      return;
    }

    if (cmd === "/help") {
      await sendMessage(
        botToken,
        chatId,
        "Как пользоваться:\n" +
          "• «кофе 350» — добавить трату (описание, сумма)\n" +
          "• «такси 900 транспорт» — с указанием категории\n" +
          "• /today /week /month — итоги за период\n" +
          "• /last — последние 5 трат (можно удалить кнопкой)\n" +
          "• /edit ID сумма описание категория — исправить трату\n" +
          "• /del ID — удалить трату\n" +
          "• /limit категория сумма — лимит на месяц, например: /limit еда 15000\n" +
          "• /panel — открыть веб-панель (вход без пароля)",
      );
      return;
    }

    if (cmd === "/panel") {
      const link = await issueLoginLink(botToken, panelUrl, from.id);
      await sendMessage(botToken, chatId, "Ссылка действительна 10 минут и одноразовая:", {
        buttons: [[{ text: "📊 Открыть панель", url: link }]],
      });
      return;
    }

    if (cmd === "/today" || cmd === "/week" || cmd === "/month") {
      const period = cmd.slice(1) as "today" | "week" | "month";
      await sendMessage(botToken, chatId, await categorySummaryText(from.id, period));
      return;
    }

    if (cmd === "/last") {
      const rows = await pgSelect<any>(
        "expenses",
        `user_id=eq.${from.id}&select=id,amount,currency,category,description,spent_at&order=created_at.desc&limit=5`,
      );
      if (!rows.length) {
        await sendMessage(botToken, chatId, "Трат пока нет.");
        return;
      }
      for (const r of rows) {
        await sendMessage(
          botToken,
          chatId,
          `${r.spent_at} — <b>${fmt(r.amount, r.currency)}</b>\n${r.description || "—"} · ${r.category} (#${r.id})`,
          { buttons: [[{ text: "🗑 Удалить", callback_data: `del:${r.id}` }]] },
        );
      }
      return;
    }

    if (cmd === "/del") {
      const id = Number(rest[0]);
      if (!id) {
        await sendMessage(botToken, chatId, "Формат: /del ID (id смотри в /last)");
        return;
      }
      const deleted = await pgDelete("expenses", `id=eq.${id}&user_id=eq.${from.id}`);
      await sendMessage(botToken, chatId, deleted.length ? "✅ Удалено." : "Не нашёл такую трату.");
      return;
    }

    if (cmd === "/edit") {
      const id = Number(rest[0]);
      const remainder = rest.slice(1).join(" ");
      const parsed = parseExpenseMessage(remainder);
      if (!id || !parsed) {
        await sendMessage(botToken, chatId, "Формат: /edit ID сумма описание категория\nНапример: /edit 42 400 такси транспорт");
        return;
      }
      const updated = await pgUpdate(
        "expenses",
        `id=eq.${id}&user_id=eq.${from.id}`,
        { amount: parsed.amount, description: parsed.description, category: parsed.category, updated_at: new Date().toISOString() },
      );
      await sendMessage(botToken, chatId, updated.length ? "✅ Исправлено." : "Не нашёл такую трату.");
      return;
    }

    if (cmd === "/limit") {
      const amount = Number(rest[rest.length - 1]?.replace(",", "."));
      const catWords = rest.slice(0, -1).join(" ");
      const category = resolveExplicitCategory(catWords) ?? resolveExplicitCategory(rest[0] ?? "");
      if (!category || !amount || amount <= 0) {
        await sendMessage(
          botToken,
          chatId,
          "Формат: /limit категория сумма\nНапример: /limit еда 15000\nКатегории: " + CATEGORY_NAMES.join(", "),
        );
        return;
      }
      await pgInsert("budgets", { user_id: from.id, category, monthly_limit: amount }, { onConflict: "user_id,category" });
      await sendMessage(botToken, chatId, `✅ Лимит по «${category}»: ${fmt(amount, "RUB")} в месяц.`);
      return;
    }

    await sendMessage(botToken, chatId, "Не знаю такую команду. /help — список команд.");
    return;
  }

  // Plain message => try to record an expense
  const parsed = parseExpenseMessage(text);
  if (!parsed) {
    await sendMessage(
      botToken,
      chatId,
      "Не нашёл сумму в сообщении 🤔\nПример: <code>кофе 350</code> или <code>такси 900 транспорт</code>",
    );
    return;
  }

  const [row] = await pgInsert<any>("expenses", {
    user_id: from.id,
    amount: parsed.amount,
    currency: parsed.currency,
    description: parsed.description,
    category: parsed.category,
    raw_text: text,
    spent_at: localDateStr(),
  });

  await sendMessage(
    botToken,
    chatId,
    `✅ ${fmt(parsed.amount, parsed.currency)} — ${parsed.description}\nКатегория: ${parsed.category}`,
    { buttons: [[{ text: "🗑 Удалить", callback_data: `del:${row.id}` }]] },
  );

  const warning = await checkBudgetWarning(from.id, parsed.category, parsed.currency);
  if (warning) await sendMessage(botToken, chatId, warning);
}

// ---------------------------------------------------------------------------
// HTTP router
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  let path = url.pathname;
  path = path.replace(/^\/functions\/v1/, "");
  path = path.replace(/^\/app/, "");
  if (path === "") path = "/";

  try {
    // --- One-off admin helpers, protected by the webhook secret as a bearer key.
    // Not linked from anywhere; used once during setup to avoid needing an
    // outbound network path to api.telegram.org from the deploy tooling.
    if (path === "/admin/setup-webhook" && req.method === "GET") {
      const secret = await getSetting("telegram_webhook_secret");
      if (!secret || url.searchParams.get("key") !== secret) {
        return json({ error: "forbidden" }, { status: 403 });
      }
      const botToken = await getSetting("telegram_bot_token");
      if (!botToken) return json({ error: "bot token not configured" }, { status: 500 });
      const result = await setWebhook(botToken, `${PUBLIC_BASE_URL}/bot`, secret);
      return json({ webhookUrl: `${PUBLIC_BASE_URL}/bot`, telegram: result });
    }

    if (path === "/admin/get-me" && req.method === "GET") {
      const secret = await getSetting("telegram_webhook_secret");
      if (!secret || url.searchParams.get("key") !== secret) {
        return json({ error: "forbidden" }, { status: 403 });
      }
      const botToken = await getSetting("telegram_bot_token");
      if (!botToken) return json({ error: "bot token not configured" }, { status: 500 });
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      return json(await res.json());
    }

    // --- Telegram webhook ---
    if (path === "/bot" && req.method === "POST") {
      const secret = await getSetting("telegram_webhook_secret");
      if (secret && req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
        return json({ error: "forbidden" }, { status: 403 });
      }
      const botToken = await getSetting("telegram_bot_token");
      if (!botToken) return json({ error: "bot not configured" }, { status: 500 });
      const panelUrl = PUBLIC_BASE_URL;
      const update = await req.json();
      try {
        await handleUpdate(update, botToken, panelUrl);
      } catch (e) {
        console.error("handleUpdate error", e);
      }
      return json({ ok: true });
    }

    // --- Panel page ---
    if (path === "/" && req.method === "GET") {
      return html(renderPanel());
    }

    // --- Auth ---
    if (path === "/api/login" && req.method === "POST") {
      const { token } = await req.json().catch(() => ({}));
      if (!token) return json({ error: "token required" }, { status: 400 });
      const rows = await pgSelect<{ token: string; telegram_id: number; expires_at: string; used_at: string | null }>(
        "login_tokens",
        `token=eq.${encodeURIComponent(token)}&select=token,telegram_id,expires_at,used_at`,
      );
      const row = rows[0];
      if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
        return json({ error: "invalid or expired token" }, { status: 401 });
      }
      await pgUpdate("login_tokens", `token=eq.${encodeURIComponent(token)}`, { used_at: new Date().toISOString() });
      const sessionToken = randomToken(24);
      await pgInsert("sessions", { token: sessionToken, telegram_id: row.telegram_id });
      return json({ ok: true }, { headers: { "Set-Cookie": sessionCookieHeader(sessionToken) } });
    }

    if (path === "/api/logout" && req.method === "POST") {
      const cookies = parseCookies(req.headers.get("cookie"));
      if (cookies[SESSION_COOKIE]) await pgDelete("sessions", `token=eq.${encodeURIComponent(cookies[SESSION_COOKIE])}`);
      return json({ ok: true }, { headers: { "Set-Cookie": clearCookieHeader() } });
    }

    // Everything below requires a session
    const session = await getSession(req);
    if (!session) return json({ error: "unauthorized" }, { status: 401 });

    if (path === "/api/me" && req.method === "GET") {
      return json(session);
    }

    if (path === "/api/categories" && req.method === "GET") {
      return json(CATEGORY_NAMES);
    }

    if (path === "/api/summary" && req.method === "GET") {
      const period = (url.searchParams.get("period") ?? "month") as "today" | "week" | "month";
      const today = localDateStr();
      const from = periodStart(period, today);
      const rows = await pgSelect<{ amount: number; currency: string; category: string }>(
        "expenses",
        `user_id=eq.${session.telegram_id}&spent_at=gte.${from}&select=amount,currency,category`,
      );
      const totals: Record<string, number> = {};
      const catMap: Record<string, { total: number; currency: string }> = {};
      for (const r of rows) {
        totals[r.currency] = (totals[r.currency] ?? 0) + Number(r.amount);
        const key = `${r.category}__${r.currency}`;
        if (!catMap[key]) catMap[key] = { total: 0, currency: r.currency };
        catMap[key].total += Number(r.amount);
      }
      let budgets: { category: string; monthly_limit: number; currency: string }[] = [];
      if (period === "month") {
        budgets = await pgSelect(
          "budgets",
          `user_id=eq.${session.telegram_id}&select=category,monthly_limit,currency`,
        );
      }
      const by_category = Object.entries(catMap)
        .map(([key, v]) => {
          const category = key.split("__")[0];
          const budget = budgets.find((b) => b.category === category && b.currency === v.currency);
          return { category, total: v.total, currency: v.currency, limit: budget?.monthly_limit ?? null };
        })
        .sort((a, b) => b.total - a.total);
      return json({ period, totals_by_currency: totals, by_category, count: rows.length });
    }

    if (path === "/api/expenses" && req.method === "GET") {
      const period = (url.searchParams.get("period") ?? "month") as "today" | "week" | "month";
      const today = localDateStr();
      const from = periodStart(period, today);
      const rows = await pgSelect(
        "expenses",
        `user_id=eq.${session.telegram_id}&spent_at=gte.${from}&select=id,amount,currency,description,category,spent_at&order=spent_at.desc,created_at.desc`,
      );
      return json(rows);
    }

    if (path === "/api/expenses" && req.method === "POST") {
      const body = await req.json();
      const amount = Number(body.amount);
      if (!amount || amount <= 0) return json({ error: "amount required" }, { status: 400 });
      const category = CATEGORY_NAMES.includes(body.category) ? body.category : "Прочее";
      const [row] = await pgInsert("expenses", {
        user_id: session.telegram_id,
        amount,
        currency: body.currency || "RUB",
        description: body.description || "",
        category,
        spent_at: body.spent_at || localDateStr(),
        raw_text: null,
      });
      return json(row, { status: 201 });
    }

    const expenseMatch = path.match(/^\/api\/expenses\/(\d+)$/);
    if (expenseMatch && req.method === "PATCH") {
      const id = Number(expenseMatch[1]);
      const body = await req.json();
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (body.amount !== undefined) patch.amount = Number(body.amount);
      if (body.description !== undefined) patch.description = body.description;
      if (body.category !== undefined) patch.category = CATEGORY_NAMES.includes(body.category) ? body.category : "Прочее";
      if (body.spent_at !== undefined) patch.spent_at = body.spent_at;
      const rows = await pgUpdate("expenses", `id=eq.${id}&user_id=eq.${session.telegram_id}`, patch);
      if (!rows.length) return json({ error: "not found" }, { status: 404 });
      return json(rows[0]);
    }

    if (expenseMatch && req.method === "DELETE") {
      const id = Number(expenseMatch[1]);
      const rows = await pgDelete("expenses", `id=eq.${id}&user_id=eq.${session.telegram_id}`);
      if (!rows.length) return json({ error: "not found" }, { status: 404 });
      return json({ ok: true });
    }

    if (path === "/api/budgets" && req.method === "GET") {
      const rows = await pgSelect("budgets", `user_id=eq.${session.telegram_id}&select=category,monthly_limit,currency`);
      return json(rows);
    }

    if (path === "/api/budgets" && req.method === "POST") {
      const body = await req.json();
      const items: { category: string; monthly_limit: number | null }[] = body.items ?? [];
      for (const item of items) {
        if (!CATEGORY_NAMES.includes(item.category)) continue;
        if (item.monthly_limit === null || item.monthly_limit === undefined || item.monthly_limit <= 0) {
          await pgDelete("budgets", `user_id=eq.${session.telegram_id}&category=eq.${encodeURIComponent(item.category)}`);
        } else {
          await pgInsert(
            "budgets",
            { user_id: session.telegram_id, category: item.category, monthly_limit: item.monthly_limit },
            { onConflict: "user_id,category" },
          );
        }
      }
      return json({ ok: true });
    }

    if (path === "/api/export.csv" && req.method === "GET") {
      const rows = await pgSelect<any>(
        "expenses",
        `user_id=eq.${session.telegram_id}&select=spent_at,amount,currency,category,description&order=spent_at.desc`,
      );
      const csv = toCsv(rows);
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="expenses.csv"',
        },
      });
    }

    return json({ error: "not found" }, { status: 404 });
  } catch (e) {
    console.error("unhandled error", e);
    return json({ error: "internal error" }, { status: 500 });
  }
});
