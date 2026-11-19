// 引擎 Worker 的入口（docs/02-engine.md 2.2–2.4）。预览、导出、杂务三种 Worker 都是这份代码。
// 启动后、装载任何模板之前先删掉联网和存储相关的全局，然后用 Comlink 暴露引擎。
import { Engine, removeNetworkGlobals, type EngineApi } from '@allay/engine';
import * as Comlink from 'comlink';
import { installDiagnosticErrorTransfer } from './error-transfer';

removeNetworkGlobals(self);
// 模板错误的结构化诊断随错误一起交给宿主（H5）
installDiagnosticErrorTransfer();

const engine = new Engine();

const api: EngineApi = {
  init: (opts, host) => engine.init(opts, host),
  load: (req, trace) => engine.load(req, trace),
  setParams: (params, trace) => engine.setParams(params, trace),
  resize: (w, h) => engine.resize(w, h),
  render: (t, quality) => engine.render(t, quality),
  configureExecutionTrace: (config) => engine.configureExecutionTrace(config),
  // 像素缓冲零拷贝传回（2.3）
  renderFrame: async (index, quality, opaque) => {
    const buf = await engine.renderFrame(index, quality, opaque);
    return Comlink.transfer(buf, [buf]);
  },
  renderThumbnail: async (req) => {
    const bitmap = await engine.renderThumbnail(req);
    return Comlink.transfer(bitmap, [bitmap]);
  },
  readPreview: async (t) => {
    const buf = await engine.readPreview(t);
    return Comlink.transfer(buf, [buf]);
  },
  checkDeterminism: (probe, others, quality) => engine.checkDeterminism(probe, others, quality),
  dispose: () => engine.dispose(),
};

Comlink.expose(api);
