// b6：用量导出 CSV 公共拼装（UTF-8 BOM + CRLF，Excel 直接打开不乱码）
export function csvCell(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function buildCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(csvCell).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function csvTime(d: Date | string | null): string {
  if (!d) return "";
  const iso = typeof d === "string" ? d : d.toISOString();
  return iso.slice(0, 16).replace("T", " ");
}
