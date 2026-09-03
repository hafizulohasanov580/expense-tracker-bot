// Thin wrapper around the Telegram Bot API.

export interface InlineButton {
  text: string;
  url?: string;
  callback_data?: string;
}

async function call(token: string, method: string, body: Record<string, unknown>) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    console.error(`telegram ${method} failed`, res.status, JSON.stringify(json));
  }
  return json;
}

export function sendMessage(
  token: string,
  chatId: number,
  text: string,
  opts: { buttons?: InlineButton[][]; replyToMessageId?: number } = {},
) {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (opts.buttons) body.reply_markup = { inline_keyboard: opts.buttons };
  if (opts.replyToMessageId) body.reply_to_message_id = opts.replyToMessageId;
  return call(token, "sendMessage", body);
}

export function answerCallbackQuery(token: string, callbackQueryId: string, text?: string) {
  return call(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  });
}

export function editMessageReplyMarkup(
  token: string,
  chatId: number,
  messageId: number,
  buttons: InlineButton[][] | null,
) {
  return call(token, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: buttons ? { inline_keyboard: buttons } : undefined,
  });
}

export function setWebhook(token: string, url: string, secretToken: string) {
  return call(token, "setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
}
