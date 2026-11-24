// 官网上的外部链接：只有 GitHub。下载也指向仓库本身（不写不存在的安装包地址和版本号）。
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
  cut: 'cut',
  try: 'try',
  templates: 'templates',
  features: 'features',
  workflow: 'workflow',
  open: 'open-source',
} as const;
