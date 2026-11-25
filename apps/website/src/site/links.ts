// 官网上的外部链接（只有 GitHub）与页面结构常量。
export const REPO_URL = 'https://github.com/Mystic-Stars/Allay-Motion';
export const LICENSE_NAME = 'GPL-3.0';

export interface Developer {
  name: string;
  url?: string;
  /** 自托管的头像（public/team/，来源登记在 ASSETS_PROVENANCE.json；官网不向 GitHub 发请求） */
  avatar: string;
}

export const DEVELOPERS: readonly Developer[] = [
  { name: 'Mystic-Stars', url: 'https://github.com/Mystic-Stars', avatar: 'team/mystic-stars.png' },
  { name: '风花叶', url: 'https://github.com/khiqwq', avatar: 'team/khiqwq.jpg' },
  { name: 'Claude', avatar: 'team/claude.png' },
];

/** 页内各节的锚点 */
export const SECTION = {
  top: 'top',
  workflow: 'workflow',
  cut: 'cut',
  try: 'try',
  templates: 'templates',
  features: 'features',
  open: 'open-source',
  end: 'end',
} as const;

/** 桌面端支持的四种导出预设（供分镜导出示意与特性卡展示） */
export const SITE_EXPORT_FORMATS = [
  { id: 'prores4444', key: 'prores', ext: '.mov' },
  { id: 'png-sequence', key: 'png', ext: '.zip' },
  { id: 'webm-vp9', key: 'webm', ext: '.webm' },
  { id: 'greenscreen-mp4', key: 'greenscreen', ext: '.mp4' },
] as const;

/** 8 个精选模板对应的代表性原版贴图 ID（public/mc/ 内均已包含） */
export const TEMPLATE_ICON_IDS: Record<string, string> = {
  'allay.builtin.block-wipe': 'minecraft:block/diamond_block',
  'allay.builtin.portal-gate': 'minecraft:block/obsidian',
  'allay.builtin.chunk-rise': 'minecraft:block/grass_block_side',
  'allay.builtin.ice-shatter': 'minecraft:block/packed_ice',
  'allay.builtin.block-punch': 'minecraft:block/tnt_side',
  'allay.builtin.item-stinger': 'minecraft:item/diamond_sword',
  'allay.builtin.item-swarm': 'minecraft:block/diamond_ore',
  'allay.builtin.advancement-toast': 'minecraft:item/diamond',
};
