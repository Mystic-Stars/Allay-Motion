const en = {
  file: 'File', edit: 'Edit', view: 'View', window: 'Window', help: 'Help',
  about: 'About', settings: 'Settings…', services: 'Services', hide: 'Hide', hideOthers: 'Hide Others', showAll: 'Show All', quit: 'Quit',
  newProject: 'New Project', open: 'Open Project…', recent: 'Open Recent', noRecent: 'No Recent Projects',
  newAnimation: 'New animation…', newAnimationFromTemplate: 'Create animation from current template…',
  save: 'Save', saveAs: 'Save As…', importTemplate: 'Import Template…', copyTemplate: 'Copy Built-in Template to Edit…',
  templateFolder: 'Open Template Folder', export: 'Export…', close: 'Close Window',
  undo: 'Undo', redo: 'Redo', cut: 'Cut', copy: 'Copy', paste: 'Paste', pasteStyle: 'Paste and Match Style', selectAll: 'Select All', reroll: 'Randomize Seed',
  theme: 'Theme', dark: 'Dark', light: 'Light', language: 'Language', system: 'Follow System',
  background: 'Preview Background', checker: 'Checkerboard', solid: 'Solid Color', guides: 'Safe Area Guides',
  sidebar: 'Toggle Sidebar', palette: 'Command Palette…', enterFullScreen: 'Enter Full Screen', exitFullScreen: 'Exit Full Screen',
  codeEditor: 'Code Editor', backToPreview: 'Back to Preview',
  minimize: 'Minimize', zoom: 'Zoom', front: 'Bring All to Front', shortcuts: 'Keyboard Shortcuts', onboarding: 'Run First-Time Setup Again', tour: 'Editor tour',
};

const zh = {
  file: '文件', edit: '编辑', view: '视图', window: '窗口', help: '帮助',
  about: '关于', settings: '设置…', services: '服务', hide: '隐藏', hideOthers: '隐藏其他', showAll: '显示全部', quit: '退出',
  newProject: '新建工程', open: '打开工程…', recent: '打开最近使用的工程', noRecent: '没有最近使用的工程',
  newAnimation: '新建动画…', newAnimationFromTemplate: '以当前模板创建动画…',
  save: '保存', saveAs: '另存为…', importTemplate: '导入模板…', copyTemplate: '复制内置模板来改…',
  templateFolder: '打开模板文件夹', export: '导出…', close: '关闭窗口',
  undo: '撤销', redo: '重做', cut: '剪切', copy: '拷贝', paste: '粘贴', pasteStyle: '粘贴并匹配样式', selectAll: '全选', reroll: '换一个随机种子',
  theme: '主题', dark: '深色', light: '浅色', language: '语言', system: '跟随系统',
  background: '预览背景', checker: '棋盘格', solid: '纯色', guides: '安全框参考线',
  sidebar: '折叠或展开侧栏', palette: '命令面板…', enterFullScreen: '进入全屏幕', exitFullScreen: '退出全屏幕',
  codeEditor: '代码编辑器', backToPreview: '返回预览',
  minimize: '最小化', zoom: '缩放', front: '前置全部窗口', shortcuts: '键盘快捷键', onboarding: '重新运行首次启动引导', tour: '新手引导',
} satisfies Record<keyof typeof en, string>;

export const macMenuMessages = { en, 'zh-CN': zh };
