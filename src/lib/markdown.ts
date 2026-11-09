// 轻量 Markdown → HTML 转换（仅富文本编辑器粘贴用，纯函数，客户端安全）
// 覆盖：标题、围栏代码块、表格、引用、有序/无序列表、分割线、
// 行内代码/粗体/斜体/删除线/链接/图片。不引第三方库。

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// 行内语法（先转义再替换）
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" class="rich-media">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener nofollow">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>");
}

// 是否像 Markdown（避免把普通文本粘贴也转了）
export function looksLikeMarkdown(s: string): boolean {
  return /(^|\n)(#{1,6}\s|```|\||>\s|[-*+]\s|\d+[.)]\s)|\*\*[^*\n]+\*\*|\[[^\]]+\]\([^)]+\)/.test(s);
}

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块 ```lang
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // 跳过收尾 ```
      const lang = fence[1];
      out.push(
        `<pre${lang ? ` data-language="${lang}"` : ""}><code>${esc(buf.join("\n"))}</code></pre>`
      );
      continue;
    }

    // 标题 # ~ ######
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lv = h[1].length;
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      i++;
      continue;
    }

    // 分割线 --- *** ___
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // 表格 | a | b |（第二行是 |---|---|）
    if (
      /^\|.*\|\s*$/.test(line) &&
      i + 1 < lines.length &&
      /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])
    ) {
      const parseRow = (l: string) =>
        l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      const head = parseRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(parseRow(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead>` +
          `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`
      );
      continue;
    }

    // 引用 >
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote><p>${inline(buf.join(" "))}</p></blockquote>`);
      continue;
    }

    // 列表 - / * / 1.
    const ol = /^\d+[.)]\s+/.test(line);
    if (ol || /^[-*+]\s+/.test(line)) {
      const itemRe = ol ? /^\d+[.)]\s+/ : /^[-*+]\s+/;
      const items: string[] = [];
      while (i < lines.length && itemRe.test(lines[i])) {
        items.push(`<li>${inline(lines[i++].replace(itemRe, ""))}</li>`);
      }
      const tag = ol ? "ol" : "ul";
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 段落（合并连续普通行）
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|```|>|[-*+]\s|\d+[.)]\s|\|)/.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      buf.push(lines[i++]);
    }
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }

  return out.join("");
}
