// Date / cookie / CSV helpers. All "calendar days" are computed in a fixed
// timezone offset (default Moscow, UTC+3) so that "сегодня" matches what a
// Russian-speaking user expects regardless of where the server runs.

export const TZ_OFFSET_MINUTES = 180;

export function localDateStr(d: Date = new Date()): string {
  const shifted = new Date(d.getTime() + TZ_OFFSET_MINUTES * 60000);
  return shifted.toISOString().slice(0, 10);
}

export function mondayOf(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (dow + 6) % 7; // days since Monday
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

export function firstOfMonth(dateStr: string): string {
  return dateStr.slice(0, 7) + "-01";
}

export function periodStart(period: string, today: string): string {
  if (period === "today") return today;
  if (period === "week") return mondayOf(today);
  return firstOfMonth(today); // month (default)
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function randomToken(bytes = 24): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function toCsv(rows: { spent_at: string; amount: number; currency: string; category: string; description: string }[]): string {
  const header = "Дата,Сумма,Валюта,Категория,Описание";
  const lines = rows.map((r) => {
    const cells = [r.spent_at, String(r.amount), r.currency, r.category, r.description || ""];
    return cells.map(csvCell).join(",");
  });
  return "﻿" + [header, ...lines].join("\r\n");
}

function csvCell(v: string): string {
  if (/[",\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}
