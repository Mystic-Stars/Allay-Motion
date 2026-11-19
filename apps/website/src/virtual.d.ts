declare module 'virtual:allay-builtin-templates' {
  /** packages/templates/* 的 manifest（未校验的 JSON）和打包好的单文件 ESM 源码 */
  const templates: { manifest: unknown; code: () => Promise<string> }[];
  export default templates;
}

declare module 'virtual:allay-website-mc' {
  /** public/mc/ 里提取好的原版贴图（pnpm website:mc）；没有提取时为 null */
  const mc: { gameVersion: string; files: string[] } | null;
  export default mc;
}
