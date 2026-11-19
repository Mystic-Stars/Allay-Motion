// 音效事件（docs/03-assets.md 3.8）：内置事件表、sounds.json 的解析与跨层合并、变体选择。
import { z } from 'zod';
import { DEFAULT_NAMESPACE, parseResourceId } from './ids';
import type { LayerKind } from './stack';

/** 模板会用到的音效事件（03-assets.md 3.8 的表）。v1 内置层不提供音效，按资源栈里的 sounds.json 解析 */
export const SOUND_EVENTS = [
  'minecraft:block.stone.place',
  'minecraft:block.stone.break',
  'minecraft:block.wood.place',
  'minecraft:ui.button.click',
  'minecraft:entity.experience_orb.pickup',
  'minecraft:entity.player.levelup',
  'minecraft:ui.toast.in',
  'minecraft:ui.toast.out',
  'minecraft:ui.toast.challenge_complete',
  'minecraft:entity.generic.explode',
  'allay:whoosh',
] as const;

export type SoundEventId = (typeof SOUND_EVENTS)[number];

export interface SoundEntry {
  /** 带命名空间的音效名（type 为 file）或事件 ID（type 为 event） */
  name: string;
  type: 'file' | 'event';
  volume: number;
  pitch: number;
  weight: number;
  stream: boolean;
}

export interface SoundEvent {
  sounds: SoundEntry[];
  /** 这个事件当前的定义是否只来自 builtin 层 */
  builtinOnly: boolean;
  subtitle?: string;
  vanilla?: boolean;
  packDefinition?: boolean;
}

/** 完整事件 ID（带命名空间）→ 合并后的定义 */
export type SoundDefinitions = Map<string, SoundEvent>;

const Num = z.number().finite();

function qualify(name: string, namespace: string): string | null {
  const parsed = parseResourceId(name.includes(':') ? name : `${namespace}:${name}`);
  return parsed ? `${parsed.namespace}:${parsed.path}` : null;
}

function parseEntry(raw: unknown, namespace: string): SoundEntry | null {
  if (typeof raw === 'string') {
    const name = qualify(raw, namespace);
    return name ? { name, type: 'file', volume: 1, pitch: 1, weight: 1, stream: false } : null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== 'string') return null;
  const name = qualify(o.name, namespace);
  if (!name) return null;
  const num = (v: unknown, def: number) => {
    const r = Num.safeParse(v);
    return r.success ? r.data : def;
  };
  return {
    name,
    type: o.type === 'event' ? 'event' : 'file',
    volume: Math.max(0, num(o.volume, 1)),
    pitch: Math.max(0, num(o.pitch, 1)),
    weight: Math.max(0, Math.trunc(num(o.weight, 1))),
    stream: o.stream === true,
  };
}

export interface ParsedSoundsJson {
  events: Map<string, { sounds: SoundEntry[]; replace: boolean; subtitle?: string }>;
}

/** 宽松解析一个 sounds.json：坏掉的条目跳过，整个文件坏了就当作空 */
export function parseSoundsJson(text: string, namespace: string): ParsedSoundsJson {
  const events: ParsedSoundsJson['events'] = new Map();
  let root: unknown;
  try {
    root = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return { events };
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return { events };
  for (const [key, value] of Object.entries(root as Record<string, unknown>)) {
    const id = qualify(key, namespace);
    if (!id || typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    const sounds = Array.isArray(v.sounds) ? v.sounds.map((s) => parseEntry(s, namespace)).filter((s): s is SoundEntry => s !== null) : [];
    const subtitle = typeof v.subtitle === 'string' && v.subtitle.length <= 256 ? v.subtitle : undefined;
    events.set(id, { sounds, replace: v.replace === true, ...(subtitle !== undefined ? { subtitle } : {}) });
  }
  return { events };
}

/**
 * 合并各层的 sounds.json（从下往上）。规则与游戏一致：上层追加变体，`replace: true` 时替换。
 * 例外：只来自 builtin 层的定义，被任何上层定义时整个替换（builtin 若将来放了兜底音效，
 * 不和游戏音效混在一起随机出现）。
 */
export function mergeSoundDefinitions(sourcesBottomToTop: readonly { kind: LayerKind; parsed: ParsedSoundsJson }[]): SoundDefinitions {
  const out: SoundDefinitions = new Map();
  for (const { kind, parsed } of sourcesBottomToTop) {
    for (const [id, def] of parsed.events) {
      const prev = out.get(id);
      const builtin = kind === 'builtin';
      const replace = !prev || def.replace || (prev.builtinOnly && !builtin);
      const subtitle = replace ? def.subtitle : prev.subtitle;
      out.set(id, {
        sounds: replace ? [...def.sounds] : [...prev.sounds, ...def.sounds],
        builtinOnly: replace ? builtin : prev.builtinOnly && builtin,
        vanilla: prev?.vanilla === true || kind === 'vanilla',
        packDefinition: prev?.packDefinition === true || kind === 'pack',
        ...(subtitle !== undefined ? { subtitle } : {}),
      });
    }
  }
  return out;
}

export interface SoundVariant {
  /** 带命名空间的音效名，用 soundNameToPaths 换成文件路径 */
  file: string;
  volume: number;
  pitch: number;
  weight: number;
}

/** 展开事件的全部变体（type 为 event 的条目递归展开，带环检测） */
export function expandSoundEvent(defs: SoundDefinitions, eventId: string): SoundVariant[] {
  const id = qualify(eventId, DEFAULT_NAMESPACE);
  if (!id) return [];
  const out: SoundVariant[] = [];
  const visit = (evId: string, volume: number, pitch: number, weight: number | null, seen: Set<string>) => {
    if (seen.has(evId) || seen.size > 16 || out.length >= 1024) return;
    const def = defs.get(evId);
    if (!def) return;
    const next = new Set(seen).add(evId);
    for (const s of def.sounds) {
      if (out.length >= 1024) break;
      if (s.weight === 0) continue;
      const w = weight ?? s.weight;
      if (s.type === 'event') visit(s.name, volume * s.volume, pitch * s.pitch, w, next);
      else out.push({ file: s.name, volume: volume * s.volume, pitch: pitch * s.pitch, weight: w });
    }
  };
  visit(id, 1, 1, null, new Set());
  return out;
}

/**
 * 按权重选一个变体。r 是 [0, 1) 的随机数，由引擎用 ctx.random('sound:' + id + ':' + 序号) 给出（02-engine.md 2.10），
 * 保证预览和导出选到同一个。
 */
export function pickSoundVariant<T extends SoundVariant>(variants: readonly T[], r: number): T | null {
  const total = variants.reduce((s, v) => s + v.weight, 0);
  if (total <= 0) return null;
  let x = Math.min(Math.max(r, 0), 0.999999999) * total;
  for (const v of variants) {
    if (x < v.weight) return v;
    x -= v.weight;
  }
  return variants[variants.length - 1] ?? null;
}
