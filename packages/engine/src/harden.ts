// Worker 的纵深防御（docs/02-engine.md 2.4、01-product-architecture.md 1.6 第 7 条）。
// 真正的边界是会话级网络拦截和 CSP；这里只是让模板脚本“手边没有”联网和存储的接口。

/** 2.4 列出的全局，外加 WebTransport 和可信文字模块已捕获的字体集合。 */
export const REMOVED_GLOBALS = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'indexedDB',
  'caches',
  'importScripts',
  'BroadcastChannel',
  'WebTransport',
  'fonts',
] as const;

/**
 * 删除联网和存储相关的全局。WebIDL 的方法和属性很多定义在原型链上（如 fetch 在 WorkerGlobalScope.prototype），
 * 只删实例上的属性没用，所以沿原型链逐层删除；删不掉的再用 undefined 覆盖。最后确认它们都不可用，否则抛错。
 */
export function removeNetworkGlobals(scope: object): void {
  for (const name of REMOVED_GLOBALS) removeEverywhere(scope, name);
  // navigator.sendBeacon（Worker 的 navigator 上本来就没有，有的话也删掉）
  const nav = (scope as { navigator?: object }).navigator;
  if (nav) removeEverywhere(nav, 'sendBeacon');

  const left = REMOVED_GLOBALS.filter((name) => (scope as Record<string, unknown>)[name] !== undefined);
  if (nav && (nav as Record<string, unknown>).sendBeacon !== undefined) left.push('sendBeacon' as never);
  if (left.length > 0) throw new Error(`failed to remove worker globals: ${left.join(', ')}`);
}

function removeEverywhere(target: object, name: string): void {
  for (let obj: object | null = target; obj; obj = Object.getPrototypeOf(obj) as object | null) {
    const desc = Object.getOwnPropertyDescriptor(obj, name);
    if (!desc) continue;
    if (desc.configurable) {
      delete (obj as Record<string, unknown>)[name];
    } else if (desc.writable) {
      (obj as Record<string, unknown>)[name] = undefined;
    }
  }
  if ((target as Record<string, unknown>)[name] !== undefined) {
    try {
      Object.defineProperty(target, name, { value: undefined, writable: false, configurable: false });
    } catch {
      // 由调用方最后统一检查
    }
  }
}

/** 开发构建在 update(t) 里拦到的不确定调用（2.4）；引擎把它转成 determinism 类诊断 */
export class DeterminismViolation extends Error {
  constructor(readonly api: 'Math.random' | 'Date.now' | 'performance.now', message: string) {
    super(message);
    this.name = 'DeterminismViolation';
  }
}

/**
 * 开发构建里，在调用模板 update(t) 期间把 Math.random、Date.now、performance.now 换成会抛错的版本（2.4），
 * 尽早抓出不确定性。生产构建不拦截。
 */
export class DeterminismGuard {
  private readonly saved = { random: Math.random, now: Date.now };

  constructor(private readonly enabled: boolean) {}

  run<T>(fn: () => T): T {
    if (!this.enabled) return fn();
    const perf = (globalThis as { performance?: Performance }).performance;
    Math.random = () => {
      throw new DeterminismViolation('Math.random', 'Math.random() is not allowed in update(t); use ctx.random(key) instead');
    };
    Date.now = () => {
      throw new DeterminismViolation('Date.now', 'Date.now() is not allowed in update(t); the frame must depend only on t');
    };
    if (perf) {
      Object.defineProperty(perf, 'now', {
        configurable: true,
        writable: true,
        value: () => {
          throw new DeterminismViolation('performance.now', 'performance.now() is not allowed in update(t); the frame must depend only on t');
        },
      });
    }
    try {
      return fn();
    } finally {
      Math.random = this.saved.random;
      Date.now = this.saved.now;
      // 删掉实例上的覆盖，露出原型上的原版
      if (perf) delete (perf as unknown as Record<string, unknown>).now;
    }
  }
}
