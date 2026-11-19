// 交给编辑器控件（@allay/ui/editor）的服务：翻译、方块与物品目录、缩略图、贴图预览、图片选择、最近使用、连续操作的起止。
import { BLOCKS, ITEMS, NAMES, SOUND_EVENTS } from '@allay/assets';
import { AllayLoader } from '@allay/mascot';
import { EditorProvider, type CatalogEntry, type CatalogGroup, type EditorServices } from '@allay/ui/editor';
import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { beginGesture, endGesture, useProjectStore } from '../../stores/projectStore';
import { useResourceStore } from '../../stores/resourceStore';
import { useUiStore } from '../../stores/uiStore';
import { previewAudio } from '../../audio/app-audio';
import { fetchSoundNames, importSound, prepareSound, useSoundLibraryStore } from '../../audio/sound-library';
import { thumbnails } from '../thumbnails/thumbnails';
import { FontField } from '../fonts/FontField';

/** 方块目录按 03-assets.md 3.7 的分组顺序排列；按顺序切成这几组 */
const BLOCK_GROUP_SIZES: [string, number][] = [
  ['natural', 16],
  ['wood', 10],
  ['building', 9],
  ['ores', 8],
  ['minerals', 10],
  ['functional', 11],
  ['wool', 16],
  ['concrete', 16],
  ['terracotta', 16],
];

function catalogEntries(ids: string[], groupOf: (i: number) => string): CatalogEntry[] {
  return ids.map((id, i) => {
    const n = NAMES[id];
    return { id, names: { 'zh-CN': n?.['zh-CN'] ?? id, en: n?.en ?? id }, group: groupOf(i) };
  });
}

const BLOCK_IDS = Object.keys(BLOCKS);
const BLOCK_GROUP_OF = (() => {
  const out: string[] = [];
  for (const [g, n] of BLOCK_GROUP_SIZES) for (let i = 0; i < n; i++) out.push(g);
  return (i: number) => out[i] ?? 'other';
})();
const BLOCK_ENTRIES = catalogEntries(BLOCK_IDS, BLOCK_GROUP_OF);
const ITEM_ENTRIES = catalogEntries(Object.keys(ITEMS), () => 'items');

/** 目录里方块和物品用到的全部贴图 ID（TextureField 从资源栈按 ID 选） */
const TEXTURE_IDS = (() => {
  const set = new Set<string>();
  const add = (ref: string) => set.add(ref.includes(':') ? ref : `minecraft:${ref}`);
  for (const b of Object.values(BLOCKS)) for (const ref of Object.values(b.tex)) add(ref);
  for (const it of Object.values(ITEMS)) add(it.tex);
  return [...set].sort();
})();

// ---- 贴图预览（资源 ID、asset:、file:），按 stamp 缓存 ----

const previewCache = new Map<string, Promise<string | null>>();
let previewStamp = '';

async function loadTexturePreview(value: string): Promise<string | null> {
  let bytes: Uint8Array | null;
  if (value.startsWith('file:')) bytes = await window.allay.files.read(value.slice(5)).catch(() => null);
  else if (value.startsWith('asset:')) {
    const t = useProjectStore.getState().template;
    const src = t?.assets;
    bytes = src ? await window.allay.templates.readAsset(src, value.slice(6)).catch(() => null) : null;
  } else bytes = (await window.allay.resources.readTexture(value).catch(() => null))?.png ?? null;
  if (!bytes) return null;
  return URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>]));
}

function texturePreview(value: string): Promise<string | null> {
  const stamp = useResourceStore.getState().state?.stamp ?? '';
  if (stamp !== previewStamp) {
    for (const p of previewCache.values()) void p.then((u) => u && URL.revokeObjectURL(u));
    previewCache.clear();
    previewStamp = stamp;
  }
  const key = value.startsWith('asset:') ? `${useProjectStore.getState().template?.ref.id}|${value}` : value;
  let p = previewCache.get(key);
  if (!p) {
    p = loadTexturePreview(value);
    previewCache.set(key, p);
  }
  return p;
}

export function EditorServicesProvider({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const fps = useProjectStore((s) => s.output.fps);
  const hasAssets = useResourceStore((s) => s.state?.hasAssets ?? false);
  const stamp = useResourceStore((s) => s.state?.stamp ?? '');
  const recent = useUiStore((s) => s.settings.editor.recent);
  const soundEvents = useSoundLibraryStore((s) => s.events);
  const soundsLoading = useSoundLibraryStore((s) => s.loading);
  const namesDownloadable = useSoundLibraryStore((s) => s.namesDownloadable);
  const value = useMemo<EditorServices>(() => {
    const blockGroups: CatalogGroup[] = BLOCK_GROUP_SIZES.map(([key]) => ({ key, label: t(`editor.picker.groups.${key}`) }));
    const itemGroups: CatalogGroup[] = [{ key: 'items', label: t('editor.picker.groups.items') }];
    return {
      t: (key, vars) => t(`editor.${key}`, vars ?? {}),
      locale: i18n.language,
      fps,
      blocks: BLOCK_ENTRIES,
      items: ITEM_ENTRIES,
      blockGroups,
      itemGroups,
      hasAssets,
      resourceStamp: stamp,
      thumbnail: async (kind, id) => (await thumbnails.get(kind, id, 64))?.url ?? null,
      texturePreview,
      textureIds: TEXTURE_IDS,
      renderFont: (props) => <FontField {...props} />,
      sounds: { library: soundEvents, common: SOUND_EVENTS, loading: soundsLoading },
      previewSound: (id) => void previewAudio.preview(id),
      prepareSound: (id) => void prepareSound(id),
      importSound,
      ...(namesDownloadable ? { fetchSoundNames } : {}),
      async pickImage() {
        const picked = await window.allay.files.pickImage();
        if (!picked) return null;
        const value = `file:${picked.ref}`;
        useProjectStore.getState().setFileName(value, picked.name);
        return { value, name: picked.name };
      },
      recent: (kind) => recent[kind],
      addRecent: (kind, v) => useUiStore.getState().addRecent(kind, v),
      gesture: (phase) => (phase === 'start' ? beginGesture() : endGesture()),
      openResources: () => useUiStore.getState().setResourcesOpen(true),
      // 缩略图未就绪：网格上一层骨架之上的飞舞（7.5 第 4 项）。整层不接收指针，点击落到下面的格子上
      pickerLoader: (loading) => (
        <div className="pointer-events-none absolute inset-0" data-testid="picker-loading-layer">
          <AllayLoader loading={loading} label={t('editor.picker.loading')} priority="picker" className="size-full" testId="picker-loader">
            {null}
          </AllayLoader>
        </div>
      ),
    };
  }, [t, i18n.language, fps, hasAssets, stamp, recent, soundEvents, soundsLoading, namesDownloadable]);
  return <EditorProvider value={value}>{children}</EditorProvider>;
}
