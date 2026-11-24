"use client";

// 富文本编辑器（reactjs-tiptap-editor 1.x 可组合 API）
// 约定：
// - 工具栏置顶；后台 full=完整能力，前台 simple=基础文字 + emoji + 图片/视频
// - 界面语言自动跟随站点语言（zh/en），无手动开关，缺省英文
// - 不引入需外接服务的功能（AI/协作/云端），提供 HTML 源码视图（代码视图）
// - 编辑器自身资源（样式/图标）全部本地打包，不依赖 CDN
// - 图片/视频上传统一走既有 /api/upload（命名规则与默认桶分流不变）
// - 粘贴与输出统一经 sanitizeRich 清洗，白名单见 src/lib/sanitize-rich.ts
// value 为受控 HTML 字符串，onChange(html) 契约与旧版一致，所有使用点零改动。

import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { ListItem } from "@tiptap/extension-list";
import { TextStyle } from "@tiptap/extension-text-style";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { RichTextProvider } from "reactjs-tiptap-editor";
import { History, RichTextUndo, RichTextRedo } from "reactjs-tiptap-editor/history";
import { Heading, RichTextHeading } from "reactjs-tiptap-editor/heading";
import { Bold, RichTextBold } from "reactjs-tiptap-editor/bold";
import { Italic, RichTextItalic } from "reactjs-tiptap-editor/italic";
import { TextUnderline, RichTextUnderline } from "reactjs-tiptap-editor/textunderline";
import { Strike, RichTextStrike } from "reactjs-tiptap-editor/strike";
import { Code, RichTextCode } from "reactjs-tiptap-editor/code";
import { CodeBlock, RichTextCodeBlock } from "reactjs-tiptap-editor/codeblock";
import { Blockquote, RichTextBlockquote } from "reactjs-tiptap-editor/blockquote";
import { HorizontalRule, RichTextHorizontalRule } from "reactjs-tiptap-editor/horizontalrule";
import { BulletList, RichTextBulletList } from "reactjs-tiptap-editor/bulletlist";
import { OrderedList, RichTextOrderedList } from "reactjs-tiptap-editor/orderedlist";
import { Link, RichTextLink } from "reactjs-tiptap-editor/link";
import { Highlight, RichTextHighlight } from "reactjs-tiptap-editor/highlight";
import { Table, RichTextTable } from "reactjs-tiptap-editor/table";
import { Emoji, RichTextEmoji } from "reactjs-tiptap-editor/emoji";
import { Clear, RichTextClear } from "reactjs-tiptap-editor/clear";
import { Color, RichTextColor } from "reactjs-tiptap-editor/color";
import { FontFamily, RichTextFontFamily } from "reactjs-tiptap-editor/fontfamily";
import { FontSize, RichTextFontSize } from "reactjs-tiptap-editor/fontsize";
import { CodeView, RichTextCodeView } from "reactjs-tiptap-editor/codeview";
import { isHtmlContent } from "@/lib/rich";
import { markdownToHtml, looksLikeMarkdown } from "@/lib/markdown";
import { sanitizeRich } from "@/lib/sanitize-rich";
import { initEditorLocale } from "@/lib/editor-locale";
import { TiptapVideo } from "./editor/TiptapVideo";

const plainToHtml = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>").replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`)
    .join("");

const toEditorHtml = (value: string) => {
  if (!value) return "";
  return isHtmlContent(value) ? sanitizeRich(value) : plainToHtml(value);
};

type Props = {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  /** 同步外部 value 的 key：编辑弹层重新打开时传入新值（如 Date.now()），强制重载内容 */
  editorKey?: string | number;
  disabled?: boolean;
  minHeight?: number;
  /** full=完整工具栏；simple=基础排版 + emoji + 图片/视频；imageOnly=仅图片/视频 */
  toolbar?: "full" | "simple" | "imageOnly";
  /** 图片上传大小上限（MB） */
  maxImageMB?: number;
  /** 视频大小提示上限（MB） */
  maxVideoMB?: number;
};

// ── 上传 ────────────────────────────────────────────────
// 统一走现有单文件接口，服务端负责命名规则与「仅存在默认桶才进桶」的分流。
async function uploadFile(file: File): Promise<string> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/upload", { method: "POST", body: fd });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.url) throw new Error(data?.error || `HTTP ${res.status}`);
  return String(data.url);
}

// 图片/视频：原版线性图标 + 点击弹层（上传 / 链接），上传规则仍走 /api/upload
const ImageIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
  </svg>
);

const VideoIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" />
    <rect x="2" y="6" width="14" height="12" rx="2" />
  </svg>
);

function MediaBtn({
  title,
  disabled,
  active,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  active?: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>
        <button
          type="button"
          aria-label={title}
          aria-expanded={active}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClick}
          className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded transition ${
            active ? "bg-white/20 text-white" : "text-[#efefef] hover:bg-white/10"
          } disabled:opacity-40`}
        >
          {children}
        </button>
      </RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side="top"
          sideOffset={6}
          className="richtext-tooltip z-[80] rounded-md px-3 py-1.5 text-xs font-medium shadow-md"
        >
          {title}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

function MediaTools({
  editor,
  maxImageMB,
  maxVideoMB,
  allowVideo = true,
  disabled,
}: {
  editor: Editor;
  maxImageMB: number;
  maxVideoMB: number;
  allowVideo?: boolean;
  disabled?: boolean;
}) {
  const imageRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<"image" | "video" | null>(null);
  const [mode, setMode] = useState<"upload" | "link">("upload");
  const [url, setUrl] = useState("");
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [busy, setBusy] = useState<"image" | "video" | null>(null);

  const close = () => {
    setOpen(null);
    setUrl("");
    setMode("upload");
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (kind: "image" | "video", e: React.MouseEvent<HTMLButtonElement>) => {
    if (open === kind) {
      close();
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    setPos({
      top: r.bottom + 8,
      left: Math.max(8, Math.min(r.left, window.innerWidth - 292)),
    });
    setMode("upload");
    setUrl("");
    setOpen(kind);
  };

  const limit = open === "video" ? maxVideoMB : maxImageMB;

  const insertImage = async (file: File) => {
    if (file.size > maxImageMB * 1024 * 1024) {
      window.alert(`图片超过 ${maxImageMB}MB 上限`);
      return;
    }
    try {
      setBusy("image");
      const src = await uploadFile(file);
      editor.chain().focus().setImage({ src }).run();
      close();
    } catch (e) {
      window.alert(`图片上传失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const insertVideo = async (file: File) => {
    if (file.size > maxVideoMB * 1024 * 1024) {
      window.alert(`视频超过 ${maxVideoMB}MB 上限`);
      return;
    }
    try {
      setBusy("video");
      const src = await uploadFile(file);
      editor.chain().focus().setVideo({ src }).run();
      close();
    } catch (e) {
      window.alert(`视频上传失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const insertUrl = () => {
    const v = url.trim();
    if (!v) return;
    if (open === "image") editor.chain().focus().setImage({ src: v }).run();
    else if (open === "video") editor.chain().focus().setVideo({ src: v }).run();
    close();
  };

  return (
    <>
      <MediaBtn title="插入图片" disabled={disabled || busy !== null} active={open === "image"} onClick={(e) => toggle("image", e)}>
        <ImageIcon />
      </MediaBtn>
      {allowVideo && (
        <MediaBtn
          title="插入视频"
          disabled={disabled || busy !== null}
          active={open === "video"}
          onClick={(e) => toggle("video", e)}
        >
          <VideoIcon />
        </MediaBtn>
      )}
      {open && (
        <div
          ref={panelRef}
          style={{ position: "fixed", top: pos.top, left: pos.left }}
          className="z-[60] w-[284px] rounded-lg border border-zinc-600 bg-[#101a42] p-3 shadow-2xl"
        >
          <div className="mb-2 flex gap-1 rounded-md bg-zinc-900/70 p-1">
            <button
              type="button"
              onClick={() => setMode("upload")}
              className={`flex-1 rounded px-2 py-1 text-xs ${mode === "upload" ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
            >
              上传
            </button>
            <button
              type="button"
              onClick={() => setMode("link")}
              className={`flex-1 rounded px-2 py-1 text-xs ${mode === "link" ? "bg-indigo-600 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
            >
              {open === "image" ? "链接" : "外链视频"}
            </button>
          </div>
          {mode === "upload" ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => (open === "image" ? imageRef.current?.click() : videoRef.current?.click())}
              className="w-full rounded-md border border-dashed border-zinc-600 px-3 py-4 text-center text-xs text-zinc-300 hover:border-indigo-500 hover:text-white disabled:opacity-50"
            >
              {busy ? "上传中…" : `选择${open === "image" ? "图片" : "视频"}文件`}
              <span className="mt-1 block text-xs text-zinc-500">≤ {limit}MB</span>
            </button>
          ) : (
            <div className="flex gap-2">
              <input
                autoFocus
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") insertUrl();
                }}
                placeholder="https://"
                className="min-w-0 flex-1 rounded-md border border-zinc-600 bg-zinc-950/80 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-indigo-500"
              />
              <button
                type="button"
                onClick={insertUrl}
                className="shrink-0 rounded-md bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-500"
              >
                插入
              </button>
            </div>
          )}
        </div>
      )}
      <input
        ref={imageRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void insertImage(f);
        }}
      />
      {allowVideo && (
        <input
          ref={videoRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void insertVideo(f);
          }}
        />
      )}
    </>
  );
}

const ToolbarShell = ({ children }: { children: React.ReactNode }) => (
  <div className="rte-toolbar flex flex-nowrap items-center gap-0.5 overflow-x-auto border-b border-zinc-700 px-1.5 py-1.5 [&>*]:shrink-0 md:flex-wrap md:overflow-visible">
    {children}
  </div>
);

const Sep = () => <span className="mx-1 h-5 w-px shrink-0 bg-white/20" />;

function EditorToolbar({
  editor,
  variant,
  maxImageMB,
  maxVideoMB,
  disabled,
}: {
  editor: Editor;
  variant: "full" | "simple" | "imageOnly";
  maxImageMB: number;
  maxVideoMB: number;
  disabled?: boolean;
}) {
  if (variant === "imageOnly") {
    return (
      <ToolbarShell>
        <MediaTools editor={editor} maxImageMB={maxImageMB} maxVideoMB={maxVideoMB} disabled={disabled} />
      </ToolbarShell>
    );
  }

  const simple = variant === "simple";

  return (
    <ToolbarShell>
      <RichTextUndo />
      <RichTextRedo />
      <Sep />
      {!simple && (
        <>
          <RichTextHeading />
          <RichTextFontFamily />
          <RichTextFontSize />
          <Sep />
        </>
      )}
      <RichTextBold />
      <RichTextItalic />
      <RichTextUnderline />
      <RichTextStrike />
      {!simple && <RichTextCode />}
      <Sep />
      {!simple && <RichTextColor />}
      <RichTextBulletList />
      <RichTextOrderedList />
      <RichTextBlockquote />
      {!simple && <RichTextCodeBlock />}
      <Sep />
      {!simple && <RichTextHighlight />}
      <RichTextLink />
      {!simple && <RichTextTable />}
      {!simple && <RichTextHorizontalRule />}
      <RichTextEmoji />
      {!simple && <RichTextClear />}
      {!simple && (
        <>
          <Sep />
          <RichTextCodeView />
        </>
      )}
      <Sep />
      <MediaTools editor={editor} maxImageMB={maxImageMB} maxVideoMB={maxVideoMB} disabled={disabled} />
    </ToolbarShell>
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
  const editorRef = useRef<Editor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lastEmitted = useRef<string>(value);

  // 初始化语言（跟随站点语言，缺省英文）
  useEffect(() => {
    initEditorLocale();
  }, []);

  const extensions = useMemo(
    () => [
      Document,
      Paragraph,
      Text,
      ListItem,
      History,
      Bold,
      Italic,
      TextUnderline,
      Strike,
      Code,
      CodeBlock,
      Blockquote,
      HorizontalRule,
      Heading.configure({ levels: [1, 2, 3, 4, 5, 6] }),
      BulletList,
      OrderedList,
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { target: "_blank", rel: "noopener nofollow" },
      }),
      Highlight.configure({ multicolor: true }),
      Table.configure({ resizable: false }),
      Emoji,
      Clear,
      // 字体 / 字号 / 文字颜色依赖 TextStyle mark
      TextStyle,
      FontFamily.configure({
        fontFamilyList: [
          { name: "默认", value: "Default" },
          { name: "黑体", value: '"Heiti SC","Microsoft YaHei",sans-serif' },
          { name: "宋体", value: '"Songti SC",SimSun,serif' },
          { name: "楷体", value: '"Kaiti SC",KaiTi,serif' },
          { name: "仿宋", value: '"FangSong",FangSong_GB2312,serif' },
          { name: "Arial", value: "Arial,Helvetica,sans-serif" },
          { name: "Georgia", value: "Georgia,serif" },
          { name: "Courier New", value: '"Courier New",Courier,monospace' },
        ],
      }),
      FontSize.configure({
        fontSizes: [
          { name: "默认", value: "Default" },
          { name: "12px", value: "12px" },
          { name: "14px", value: "14px" },
          { name: "16px", value: "16px" },
          { name: "18px", value: "18px" },
          { name: "20px", value: "20px" },
          { name: "24px", value: "24px" },
          { name: "28px", value: "28px" },
          { name: "32px", value: "32px" },
          { name: "40px", value: "40px" },
          { name: "48px", value: "48px" },
        ],
      }),
      Color.configure({
        colors: [
          "#ffffff", "#efefef", "#bdc7e6", "#97a4cf",
          "#38bdf8", "#2aa8ff", "#6366f1", "#8b5cf6",
          "#22d3ee", "#10b981", "#f59e0b", "#ef4444",
          "#f472b6", "#94a3b8", "#0b2476", "#000000",
        ],
      }),
      CodeView,
      Image.configure({ HTMLAttributes: { class: "rich-media" } }),
      TiptapVideo,
      Placeholder.configure({ placeholder }),
    ],
    [placeholder]
  );

  const editor = useEditor(
    {
      immediatelyRender: false,
      editable: !disabled,
      content: toEditorHtml(value),
      extensions,
      editorProps: {
        attributes: { class: "tiptap-prose focus:outline-none" },
        // 粘贴的 HTML 先清洗，再交给 Tiptap 解析
        transformPastedHTML: (html) => sanitizeRich(html),
        handlePaste: (view, event) => {
          // 无 HTML 的剪贴板内容若是 Markdown，转换后同样清洗再插入
          const htmlData = event.clipboardData?.getData("text/html");
          const text = event.clipboardData?.getData("text/plain") || "";
          if (htmlData || !text || !looksLikeMarkdown(text)) return false;
          const html = sanitizeRich(markdownToHtml(text));
          editorRef.current?.chain().focus().insertContent(html).run();
          return true;
        },
      },
      onCreate: ({ editor: e }) => {
        editorRef.current = e;
      },
      onUpdate: ({ editor: e }) => {
        // 输出统一清洗：存储与渲染都只接受白名单内内容
        const html = sanitizeRich(e.getHTML());
        lastEmitted.current = html;
        onChangeRef.current(html);
      },
    },
    [extensions]
  );

  useEffect(() => {
    editorRef.current = editor;
    if (editor) editor.setEditable(!disabled);
  }, [editor, disabled]);

  // 外部 value 变化 → 同步（弹层重开/异步加载）。emitUpdate:false 避免回环。
  useEffect(() => {
    if (!editor) return;
    if (value === lastEmitted.current) return;
    const html = toEditorHtml(value);
    editor.commands.setContent(html, { emitUpdate: false });
    lastEmitted.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, value, editorKey]);

  if (!editor) {
    return (
      <div
        className="rte-shell rounded-lg border border-zinc-700"
        style={{ minHeight }}
      />
    );
  }

  return (
    <RichTextProvider editor={editor}>
      <div
        className={`rte-shell overflow-hidden rounded-lg border ${disabled ? "opacity-60" : ""}`}
      >
        <EditorToolbar
          editor={editor}
          variant={toolbar}
          maxImageMB={maxImageMB}
          maxVideoMB={maxVideoMB}
          disabled={disabled}
        />
        <EditorContent
          editor={editor}
          style={{ minHeight, maxHeight: 600, overflowY: "auto" }}
          className="rte-content p-4"
        />
      </div>
    </RichTextProvider>
  );
}
