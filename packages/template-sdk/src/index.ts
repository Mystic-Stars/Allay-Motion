// 模板 SDK：模板运行时契约的类型、manifest 与参数的 schema 和校验、迁移、派生、预设，
// 以及宿主与引擎之间的协议 schema（docs/04-templates.md、02-engine.md 2.3）。
export type * from './runtime';
export * from './manifest';
export * from './font';
export * from './params';
export * from './semver';
export * from './migrate';
export * from './derive';
export * from './preset';
export * from './protocol';
export * from './composition';
export * from './studio';
