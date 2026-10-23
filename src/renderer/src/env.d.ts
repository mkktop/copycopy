/// <reference types="vite/client" />

/**
 * 让纯 tsc 也能看懂单文件组件。
 * 有了它 typecheck 才有意义，缺了它所有 .vue 导入都会报 TS2307。
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
declare const __APP_VERSION__: string
