// reactjs-tiptap-editor 1.0.48 的 lib 把整份 React 19.3.1 打进了自己的 chunk
// （react-*.js / react-*.cjs），与 Next 使用的 React 形成「双 React 实例」，
// 导致 Radix useId / tiptap hooks 读到空的 dispatcher：
//   TypeError: Cannot read properties of null (reading 'useId')
// 这里在 webpack 层把这几个文件替换成本文件，统一复用应用自身的 React。
//
// 导出形状必须与打包产物一致：n = 懒加载 CJS 工厂，r = __toESM，t = 返回 React 的 thunk。
import * as React from "react";

const hasOwn = Object.prototype.hasOwnProperty;

// 对应 rolldown runtime 的 o(): 惰性执行 CJS 工厂并缓存结果
export const n = (factory, cached) => () => {
  if (!cached) {
    cached = { exports: {} };
    factory(cached.exports, cached, cached.exports);
  }
  return cached.exports;
};

// 对应 rolldown runtime 的 s(): 把源对象属性以只读 getter 拷到目标对象
function copyProps(target, source, skipDefault) {
  if (source && (typeof source === "object" || typeof source === "function")) {
    for (const key of Object.getOwnPropertyNames(source)) {
      if (hasOwn.call(target, key) || key === skipDefault) continue;
      const desc = Object.getOwnPropertyDescriptor(source, key);
      Object.defineProperty(target, key, {
        get: (k => () => source[k])(key),
        enumerable: !desc || desc.enumerable,
      });
    }
  }
  return target;
}

// 对应 rolldown runtime 的 c(): __toESM
export const r = (mod, copy) => {
  const target = mod == null ? {} : Object.create(Object.getPrototypeOf(mod));
  if (copy || !mod || !mod.__esModule || !hasOwn.call(mod, "default")) {
    Object.defineProperty(target, "default", { value: mod, enumerable: true });
  }
  return copyProps(target, mod);
};

// 对应原先打包 React 的导出：一个返回 React 对象的 thunk
export const t = () => React;
