const en = {
  studio: 'Code Studio', source: 'Template source', composition: 'Composition JSON', library: 'Reusable compositions',
  blank: 'New blank animation', blankName: 'Blank animation', copy: 'Copy and edit', folder: 'Open source folder',
  openSource: 'Load source', save: 'Save and reload', saved: 'Saved and reloaded.', discard: 'Discard the unsaved editor text?',
  copyRequired: 'Built-in templates are read-only. Edit a user copy instead.', scriptRequired: 'Select a script template to edit its source.',
  sourceHelp: 'Edit template.js and manifest.json. Nothing runs until you save and the preview check passes.',
  externalChange: 'Files changed outside the editor. Reload the files or copy your edits before retrying.',
  conflict: 'Files changed on disk; your edits were not written.', failed: 'Operation failed', io: 'The source files could not be read or saved.',
  applyJson: 'Apply JSON', applied: 'Composition applied.', empty: 'Start with an empty composition.',
  freeze: 'Freeze as .allaytpl', freezeHelp: 'Uses the applied composition. Only checked parameters are exposed. Game files, resource packs, script packages and external images are not included.',
  packageName: 'Template name', frozen: 'Template saved.', import: 'Import composition template…', open: 'Open', instantiate: 'Use as new composition',
  chooseExposure: 'Choose exposed parameters', none: 'No reusable compositions yet.', reconnect: 'Reconnect image…', linked: 'Connected',
  reconnectHelp: 'Reconnect local images, skins and resource profiles before using this template.',
  overrides: 'Exposed parameter values (JSON)', included: 'Template dependencies', rawInvalid: 'Invalid JSON or parameter value.',
  refresh: 'Refresh library', discardDraft: 'Discard JSON edits',
  chooseSkin: 'Choose a local skin', chooseProfile: 'Choose a local resource profile', importSkin: 'Import skin PNG…',
  classic: 'Classic', slim: 'Slim',
};

const zh: Record<keyof typeof en, string> = {
  studio: '代码工作室', source: '模板源码', composition: '合成 JSON', library: '可复用合成',
  blank: '新建空白动画', blankName: '空白动画', copy: '复制后编辑', folder: '打开源码文件夹',
  openSource: '读取源码', save: '保存并重载', saved: '已保存并重载。', discard: '放弃尚未保存的编辑内容？',
  copyRequired: '内置模板只读，请先复制一份再编辑。', scriptRequired: '选择一个脚本模板来编辑源码。',
  sourceHelp: '编辑 template.js 与 manifest.json。保存时先试运行，成功后才切换预览。',
  externalChange: '磁盘文件已在编辑器之外更新。请重新读取文件，或先复制当前编辑内容再重试。',
  conflict: '磁盘文件已经更新，本次编辑没有写入。', failed: '操作未成功', io: '无法读取或保存源码文件。',
  applyJson: '应用 JSON', applied: '已应用合成。', empty: '从空白合成开始。',
  freeze: '固化为 .allaytpl', freezeHelp: '使用已应用的合成，仅暴露勾选参数。不打包游戏文件、资源包、脚本包或外部图片。',
  packageName: '模板名称', frozen: '模板已保存。', import: '导入合成模板…', open: '打开', instantiate: '用作新合成',
  chooseExposure: '选择要暴露的参数', none: '还没有可复用的合成。', reconnect: '重连图片…', linked: '已连接',
  reconnectHelp: '使用模板前请重连本机图片、皮肤与资源配置。',
  overrides: '暴露参数值（JSON）', included: '模板依赖', rawInvalid: 'JSON 或参数值不合法。',
  refresh: '刷新模板库', discardDraft: '放弃 JSON 编辑',
  chooseSkin: '选择本机皮肤', chooseProfile: '选择本机资源配置', importSkin: '导入皮肤 PNG…',
  classic: '经典模型', slim: '纤细模型',
};

export function authoringMessages(language: string): typeof en {
  return language.toLowerCase().startsWith('zh') ? zh : en;
}

export type AuthoringMessages = typeof en;
