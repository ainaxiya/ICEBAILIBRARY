import { describe, expect, it } from "vitest";
import { sanitizeRich } from "@/lib/sanitize-rich";

// e5：富文本白名单与 reactjs-tiptap-editor 实际能力对齐 + 危险内容收敛
describe("sanitizeRich / 编辑器白名单", () => {
  it("保留编辑器排版标签：标题/列表/引用/代码块/表格", () => {
    const html =
      '<h2>标题</h2><ul><li>项</li></ul><ol><li>项</li></ol><blockquote>引用</blockquote>' +
      '<pre class="language-ts" data-language="ts"><code class="language-ts">const a = 1</code></pre>' +
      '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>C</td></tr></tbody></table>';
    const out = sanitizeRich(html);
    for (const tag of ["<h2>", "<ul>", "<ol>", "<blockquote>", "<pre", "<code", "<table>", "<thead>", "<tbody>", "<th>", "<td>"]) {
      expect(out).toContain(tag);
    }
  });

  it("保留加粗/斜体/下划线/删除线/行内代码/高亮", () => {
    const out = sanitizeRich(
      '<p><strong>B</strong><em>I</em><u>U</u><s>S</s><code>c</code>' +
        '<mark data-color="#fde047" style="background-color: #fde047">H</mark></p>'
    );
    expect(out).toContain("<strong>");
    expect(out).toContain("<em>");
    expect(out).toContain("<u>");
    expect(out).toContain("<s>");
    expect(out).toContain("<code>");
    expect(out).toContain("data-color");
    expect(out).toContain("background-color");
  });

  it("图片/视频节点保留上传地址与属性", () => {
    const out = sanitizeRich(
      '<img src="/uploads/2026-11/2026-11-image-1-abc.jpg" alt="a" class="rich-media">' +
        '<video src="/uploads/2026-11/2026-11-video-2-def.mp4" controls class="rich-media" poster="/p.jpg"></video>'
    );
    expect(out).toContain('src="/uploads/2026-11/2026-11-image-1-abc.jpg"');
    expect(out).toContain('class="rich-media"');
    expect(out).toContain("<video");
    expect(out).toContain("controls");
    expect(out).toContain('poster="/p.jpg"');
  });

  it("剥离脚本、事件属性与高危样式", () => {
    const out = sanitizeRich(
      '<p onclick="alert(1)">x</p><script>alert(2)</script>' +
        '<img src="https://a.com/x.png" onerror="alert(3)">' +
        '<span style="position:fixed;top:0">s</span>' +
        '<mark style="background-color: url(javascript:alert(4))">m</mark>'
    );
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("position:fixed");
    expect(out).not.toContain("javascript:");
  });

  it("iframe 仅放行 YouTube/Bilibili 白名单域名", () => {
    const ok = sanitizeRich('<iframe src="https://www.youtube.com/embed/abc"></iframe>');
    expect(ok).toContain("<iframe");
    const bad = sanitizeRich('<iframe src="https://evil.example.com/x"></iframe>');
    expect(bad).not.toContain("<iframe");
  });

  it("链接统一补 target/rel，历史纯文本原样保留", () => {
    const out = sanitizeRich('<p><a href="https://a.com">链接</a></p>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener nofollow"');
    expect(sanitizeRich("纯文本内容\n第二行")).toBe("纯文本内容\n第二行");
  });
});
