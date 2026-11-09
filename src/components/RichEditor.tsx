"use client";

// 富文本编辑器（Tiptap v3）：API 文档级排版
// - 标题 H1–H6、引用、列表、行内代码、代码块（带语言）、表格、分割线、高亮
// - 图片/视频上传（UniversalUploader）
// - 源码模式（直接编辑 HTML，可做精细排版）
// - Markdown 粘贴自动转换（标题/列表/围栏代码/表格/粗斜体等）
// value 为受控 HTML 字符串，onChange(html) 契约与旧版一致，所有使用点零改动。
// sanitizeRich 白名单须与本编辑器能力对齐（src/lib/sanitize.server.ts）。

import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { Mark, mergeAttributes } from "@tiptap/core";
import { isHtmlContent } from "@/lib/rich";
import { markdownToHtml, looksLikeMarkdown } from "@/lib/markdown";
import UniversalUploader from "@/components/UniversalUploader";
import { TiptapVideo } from "./editor/TiptapVideo";

// ── 高亮 Mark（span.hl，蓝字加粗，样式见 globals.css）──
const Highlight = Mark.create({
  name: "highlight",
  parseHTML: () => [{ tag: "span.hl" }],
  renderHTML: ({ HTMLAttributes }) => [
    "span",
    mergeAttributes(HTMLAttributes, { class: "hl" }),
    0,
  ],
});

// 自动命令的类型声明（toggleHighlight 由 Mark 名生成）
declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    highlight: {
      toggleHighlight: () => ReturnType;
    };
  }
}

const plainToHtml = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>").replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`)
    .join("");

type Props = {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  /** 同步外部 value 的 key：编辑弹层重新打开时传入新值（如 Date.now()），强制重载内容 */
  editorKey?: string | number;
  disabled?: boolean;
  minHeight?: number;
  /** full=完整工具栏；simple=基础排版；imageOnly=仅图片（工单/消息） */
  toolbar?: "full" | "simple" | "imageOnly";
  /** 图片上传大小上限（MB） */
  maxImageMB?: number;
  /** 视频大小提示上限（MB） */
  maxVideoMB?: number;
};

// 工具按钮：图标 + title + active 高亮
function ToolBtn({
  onClick,
  active,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} // 保持编辑器选区不丢失
      onClick={onClick}
      className={`min-w-[28px] rounded px-1.5 py-1 text-sm transition ${
        active
          ? "bg-emerald-500/20 text-emerald-300"
          : "text-zinc-300 hover:bg-zinc-700/60 hover:text-white"
      } disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

const Divider = () => <span className="mx-1 h-5 w-px bg-zinc-700" />;

// 代码块语言（写入 data-language，仅样式标注）
const CODE_LANGS = [
  ["", "代码语言"],
  ["text", "纯文本"],
  ["javascript", "JavaScript"],
  ["typescript", "TypeScript"],
  ["python", "Python"],
  ["bash", "Bash"],
  ["json", "JSON"],
  ["html", "HTML"],
  ["css", "CSS"],
  ["sql", "SQL"],
  ["go", "Go"],
  ["rust", "Rust"],
  ["java", "Java"],
  ["yaml", "YAML"],
  ["markdown", "Markdown"],
  ["diff", "Diff"],
];

// 表格菜单（插入/行列操作/合并拆分）
function TableMenu({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const act = (fn: () => void) => {
    fn();
    setOpen(false);
  };
  return (
    <span className="relative">
      <ToolBtn
        title="表格"
        active={editor.isActive("table")}
        onClick={() => setOpen((o) => !o)}
      >
        ▦
      </ToolBtn>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-9 z-20 w-56 rounded-lg border border-zinc-700 bg-zinc-900 p-2 shadow-xl">
            <p className="mb-1.5 px-1 text-[11px] text-zinc-500">插入</p>
            <div className="mb-2 grid grid-cols-2 gap-1">
              <ToolBtn title="3×3 表格（含表头）" onClick={() => act(() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}>
                <span className="text-xs">3×3 表格</span>
              </ToolBtn>
              <ToolBtn title="删除表格" disabled={!editor.isActive("table")} onClick={() => act(() => editor.chain().focus().deleteTable().run())}>
                <span className="text-xs">删除表格</span>
              </ToolBtn>
            </div>
            <p className="mb-1.5 px-1 text-[11px] text-zinc-500">行列</p>
            <div className="mb-2 grid grid-cols-2 gap-1">
              <ToolBtn title="前插列" disabled={!editor.isActive("table")} onClick={() => act(() => editor.chain().focus().addColumnBefore().run())}><span className="text-xs">←插列</span></ToolBtn>
              <ToolBtn title="后插列" disabled={!editor.isActive("table")} onClick={() => act(() => editor.chain().focus().addColumnAfter().run())}><span className="text-xs">插列→</span></ToolBtn>
              <ToolBtn title="删除列" disabled={!editor.isActive("table")} onClick={() => act(() => editor.chain().focus().deleteColumn().run())}><span className="text-xs">删列</span></ToolBtn>
              <ToolBtn title="前插行" disabled={!editor.isActive("table")} onClick={() => act(() => editor.chain().focus().addRowBefore().run())}><span className="text-xs">↑插行</span></ToolBtn>
              <ToolBtn title="后插行" disabled={!editor.isActive("table")} onClick={() => act(() => editor.chain().focus().addRowAfter().run())}><span className="text-xs">插行↓</span></ToolBtn>
              <ToolBtn title="删除行" disabled={!editor.isActive("table")} onClick={() => act(() => editor.chain().focus().deleteRow().run())}><span className="text-xs">删行</span></ToolBtn>
            </div>
            <p className="mb-1.5 px-1 text-[11px] text-zinc-500">单元格</p>
            <div className="grid grid-cols-2 gap-1">
              <ToolBtn title="合并单元格" disabled={!editor.isActive("table")} onClick={() => act(() => editor.chain().focus().mergeCells().run())}><span className="text-xs">合并</span></ToolBtn>
              <ToolBtn title="拆分单元格" disabled={!editor.isActive("table")} onClick={() => act(() => editor.chain().focus().splitCell().run())}><span className="text-xs">拆分</span></ToolBtn>
              <ToolBtn title="表头列（切换）" disabled={!editor.isActive("table")} onClick={() => act(() => editor.chain().focus().toggleHeaderColumn().run())}><span className="text-xs">表头列</span></ToolBtn>
              <ToolBtn title="表头行（切换）" disabled={!editor.isActive("table")} onClick={() => act(() => editor.chain().focus().toggleHeaderRow().run())}><span className="text-xs">表头行</span></ToolBtn>
            </div>
          </div>
        </>
      )}
    </span>
  );
}

function Toolbar({
  editor,
  sourceMode,
  onToggleSource,
  variant = "full",
  maxImageMB = 10,
  maxVideoMB = 100,
}: {
  editor: Editor;
  sourceMode: boolean;
  onToggleSource: () => void;
  variant?: "full" | "simple" | "imageOnly";
  maxImageMB?: number;
  maxVideoMB?: number;
}) {
  const setLink = () => {
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("链接地址（留空移除链接）", prev || "https://");
    if (url === null) return;
    if (!url.trim()) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
  };

  const isSimple = variant === "simple";

  // 图片插入 + 上传（各工具栏变体共用）
  const imageBtns = (
    <>
      <ToolBtn title="图片（上传/URL）" active={editor.isActive("image")} onClick={() => {
        const url = window.prompt("图片地址（或点 ⬆ 上传）", "https://");
        if (url && url.trim()) editor.chain().focus().setImage({ src: url.trim() }).run();
      }}>🖼</ToolBtn>
      <label title={`上传图片（≤${maxImageMB}MB）`} className="min-w-[28px] cursor-pointer rounded px-1.5 py-1 text-sm text-zinc-300 transition hover:bg-zinc-700/60 hover:text-white">
        ⬆
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            if (f.size > maxImageMB * 1024 * 1024) {
              window.alert(`图片超过 ${maxImageMB}MB 上限`);
              return;
            }
            const fd = new FormData();
            fd.append("file", f);
            try {
              const res = await fetch("/api/upload", { method: "POST", body: fd });
              const d = await res.json();
              if (d?.url) editor.chain().focus().setImage({ src: d.url }).run();
            } catch {
              /* 上传失败静默 */
            }
          }}
        />
      </label>
    </>
  );

  if (variant === "imageOnly") {
    return (
      <div className="flex flex-wrap items-center gap-0.5 border-t border-zinc-700 bg-zinc-800/40 px-1.5 py-1">
        {imageBtns}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-t border-zinc-700 bg-zinc-800/40 px-1.5 py-1">
      {!isSimple && (
        <>
      {/* 标题 */}
      {([1, 2, 3, 4] as const).map((lv) => (
        <ToolBtn
          key={lv}
          title={`标题 ${lv}`}
          active={editor.isActive("heading", { level: lv })}
          onClick={() => editor.chain().focus().toggleHeading({ level: lv }).run()}
        >
          <b className="text-xs">H{lv}</b>
        </ToolBtn>
      ))}
      <ToolBtn title="正文" active={!editor.isActive("heading") && !editor.isActive("codeBlock")} onClick={() => editor.chain().focus().setParagraph().run()}>
        <b className="text-xs">¶</b>
      </ToolBtn>
      <Divider />
        </>
      )}
      {/* 字体样式 */}
      <ToolBtn title="加粗" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}><b>B</b></ToolBtn>
      <ToolBtn title="斜体" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}><i>I</i></ToolBtn>
      <ToolBtn title="下划线" active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()}><u>U</u></ToolBtn>
      <ToolBtn title="删除线" active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()}><s>S</s></ToolBtn>
      <ToolBtn title="高亮（蓝字强调）" active={editor.isActive("highlight")} onClick={() => editor.chain().focus().toggleHighlight().run()}>
        <b className="text-[#5cc9f9]">Hl</b>
      </ToolBtn>
      <Divider />
      {/* 块级排版 */}
      <ToolBtn title="引用" active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}>❝</ToolBtn>
      <ToolBtn title="无序列表" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}>•≡</ToolBtn>
      <ToolBtn title="有序列表" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}>1≡</ToolBtn>
      <ToolBtn title="分割线" active={editor.isActive("horizontalRule")} onClick={() => editor.chain().focus().setHorizontalRule().run()}>──</ToolBtn>
      {!isSimple && (
        <>
      <Divider />
      {/* 代码 */}
      <ToolBtn title="行内代码" active={editor.isActive("code")} onClick={() => editor.chain().focus().toggleCode().run()}>‹›</ToolBtn>
      <ToolBtn title="代码块" active={editor.isActive("codeBlock")} onClick={() => editor.chain().focus().toggleCodeBlock().run()}><b className="font-mono text-xs">{"</>"}</b></ToolBtn>
      <select
        title="代码块语言"
        className="h-7 rounded bg-transparent px-1 text-xs text-zinc-300 outline-none hover:bg-zinc-700/60"
        value={(editor.getAttributes("codeBlock").language as string) || ""}
        onChange={(e) => {
          const lang = e.target.value;
          if (editor.isActive("codeBlock")) {
            editor.chain().focus().updateAttributes("codeBlock", { language: lang || null }).run();
          } else if (lang) {
            editor.chain().focus().setCodeBlock({ language: lang }).run();
          }
        }}
      >
        {CODE_LANGS.map(([v, label]) => (
          <option key={v} value={v}>{label}</option>
        ))}
      </select>
      <Divider />
        </>
      )}
      {/* 表格 / 链接 / 媒体 */}
      {!isSimple && <TableMenu editor={editor} />}
      <ToolBtn title="链接" active={editor.isActive("link")} onClick={setLink}>🔗</ToolBtn>
      {imageBtns}
      {!isSimple && (
        <ToolBtn title="视频（URL）" active={editor.isActive("video")} onClick={() => {
          const url = window.prompt(`视频地址（mp4/webm/mov，≤${maxVideoMB}MB）`, "https://");
          if (url && url.trim()) editor.chain().focus().insertContent({ type: "video", attrs: { src: url.trim() } }).run();
        }}>▶</ToolBtn>
      )}
      {!isSimple && (
        <>
      <Divider />
      {/* 源码模式 / 撤销重做 */}
      <ToolBtn title="源码模式（编辑 HTML 源码）" active={sourceMode} onClick={onToggleSource}>
        <b className="font-mono text-xs">HTML</b>
      </ToolBtn>
        </>
      )}
      <ToolBtn title="撤销" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}>↶</ToolBtn>
      <ToolBtn title="重做" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}>↷</ToolBtn>
    </div>
  );
}

export default function RichEditor({
  value,
  onChange,
  placeholder = "输入正文…支持标题/表格/代码块；可直接粘贴 Markdown 自动排版",
  editorKey,
  disabled = false,
  minHeight = 320,
  toolbar = "full",
  maxImageMB = 10,
  maxVideoMB = 100,
}: Props) {
  const [showUpload, setShowUpload] = useState(false);
  const [sourceMode, setSourceMode] = useState(false);
  const [sourceHtml, setSourceHtml] = useState("");
  const editorRef = useRef<Editor | null>(null);
  const lastEmitted = useRef<string>(value);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        link: false, // 用独立 Link 扩展（可编辑 href）
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { target: "_blank", rel: "noopener nofollow" },
      }),
      Highlight,
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Image.configure({ HTMLAttributes: { class: "rich-media" } }),
      TiptapVideo,
      Placeholder.configure({ placeholder }),
    ],
    editorProps: {
      attributes: {
        class: "tiptap-prose focus:outline-none",
      },
      handlePaste: (view, event) => {
        // 无 HTML 的剪贴板内容若是 Markdown，自动转换后插入
        const htmlData = event.clipboardData?.getData("text/html");
        const text = event.clipboardData?.getData("text/plain") || "";
        if (htmlData || !text || !looksLikeMarkdown(text)) return false;
        const html = markdownToHtml(text);
        editorRef.current?.chain().focus().insertContent(html).run();
        return true;
      },
    },
    onUpdate: ({ editor: e }) => {
      const html = e.getHTML();
      lastEmitted.current = html;
      onChange(html);
    },
    onCreate: ({ editor: e }) => {
      editorRef.current = e;
    },
  });

  // 外部 value 变化 → 同步（弹层重开/异步加载）。emitUpdate:false 避免回环。
  useEffect(() => {
    if (!editor || !value) return;
    if (value === lastEmitted.current) return;
    const html = isHtmlContent(value) ? value : plainToHtml(value);
    if (sourceMode) {
      setSourceHtml(html);
    } else {
      editor.commands.setContent(html, { emitUpdate: false });
    }
    lastEmitted.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, value, editorKey, sourceMode]);

  const toggleSource = () => {
    if (!editor) return;
    if (!sourceMode) {
      setSourceHtml(editor.getHTML());
      setSourceMode(true);
    } else {
      editor.commands.setContent(sourceHtml, { emitUpdate: false });
      lastEmitted.current = sourceHtml;
      setSourceMode(false);
    }
  };

  return (
    <div className={`overflow-hidden rounded-lg border border-zinc-700 bg-zinc-800/60 ${disabled ? "opacity-60" : ""}`}>
      <div className="relative">
        {showUpload && (
          <div className="absolute inset-x-0 top-0 z-10 border-b border-zinc-700 bg-zinc-900 p-3">
            <UniversalUploader
              multiple={false}
              accept="image"
              compact
              hint="选择图片上传后插入正文"
              onUploaded={([f]) => {
                editor?.chain().focus().setImage({ src: f.url }).run();
                setShowUpload(false);
              }}
            />
            <button type="button" className="ml-2 text-xs text-zinc-400 hover:text-zinc-200" onClick={() => setShowUpload(false)}>
              取消
            </button>
          </div>
        )}
        {sourceMode ? (
          <textarea
            value={sourceHtml}
            onChange={(e) => {
              const v = e.target.value;
              setSourceHtml(v);
              lastEmitted.current = v;
              onChange(v);
            }}
            disabled={disabled}
            spellCheck={false}
            placeholder="<p>HTML 源码…</p>"
            className="tiptap-source block w-full resize-y bg-zinc-900/60 p-4 font-mono text-xs leading-relaxed text-emerald-100 outline-none"
            style={{ minHeight, maxHeight: 600 }}
          />
        ) : (
          <EditorContent
            editor={editor}
            style={{ minHeight, maxHeight: 600, overflowY: "auto" }}
            className="bg-zinc-800/60 p-4 text-zinc-100"
          />
        )}
      </div>
      {editor && (
        <Toolbar
          editor={editor}
          sourceMode={sourceMode}
          onToggleSource={toggleSource}
          variant={toolbar}
          maxImageMB={maxImageMB}
          maxVideoMB={maxVideoMB}
        />
      )}
    </div>
  );
}
