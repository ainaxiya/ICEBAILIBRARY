// 同 tiptap-react-shim.mjs：reactjs-tiptap-editor 把 React 的 jsx-runtime 也打进了
// lib/jsx-runtime-*.js，这里换成应用自身的 react/jsx-runtime，避免第二份运行时。
// 导出形状与原产物一致：t = 返回 jsx-runtime 模块的 thunk。
import * as JsxRuntime from "react/jsx-runtime";

export const t = () => JsxRuntime;
