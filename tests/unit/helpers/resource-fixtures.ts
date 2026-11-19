// 测试夹具的生成脚本（docs/09-compliance.md 9.6：夹具全部是脚本生成的假数据，不放任何真实游戏文件）。
// 夹具在测试运行时写进临时目录，不提交二进制（.jar 也不允许提交）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';

function pngChunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/**
 * 纯色 PNG：只是测试数据，用颜色区分“这张贴图来自哪一层”，不是产品素材，也不进安装包。
 */
export function solidPng(color: string, height = 16, width = 16): Uint8Array {
  const n = Number.parseInt(color.slice(1), 16);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x++) row.set([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255], 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]),
  );
}

export function writeFiles(root: string, files: Record<string, Uint8Array | string>): void {
  for (const [rel, data] of Object.entries(files)) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
}

export interface ZipEntrySpec {
  /** 原样写进压缩包的条目名（可以是恶意的 ../x、/x、C:/x、..\x） */
  name: string;
  data: Uint8Array | string;
  method?: 'store' | 'deflate';
  /** 在中央目录里谎报的解压后大小 */
  declaredSize?: number;
}

/** 手写的最小 zip 生成器（只为了能造出正常工具拒绝生成的恶意条目） */
export function buildZip(entries: readonly ZipEntrySpec[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : Buffer.from(e.data);
    const method = e.method === 'deflate' ? 8 : 0;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const size = e.declaredSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

export function writeZip(file: string, entries: readonly ZipEntrySpec[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buildZip(entries));
}

export function packMcmeta(description: string, packFormat = 46): string {
  return JSON.stringify({ pack: { pack_format: packFormat, description } });
}

export const tex = (name: string) => `assets/minecraft/textures/block/${name}.png`;

export interface FakeVersion {
  id: string;
  type: 'release' | 'snapshot' | 'old_beta';
  releaseTime: string;
  jar: boolean;
  assetIndex?: string;
}

/** 假 .minecraft：versions/<id>/<id>.json(+jar)、assets/indexes、assets/objects。jar 里是纯色假贴图 */
export function makeFakeMinecraft(root: string, versions: readonly FakeVersion[], jarColor = '#00ff00'): void {
  for (const v of versions) {
    const dir = join(root, 'versions', v.id);
    writeFiles(dir, {
      [`${v.id}.json`]: JSON.stringify({
        id: v.id,
        type: v.type,
        releaseTime: v.releaseTime,
        ...(v.assetIndex ? { assetIndex: { id: v.assetIndex, sha1: '0'.repeat(40), size: 1, url: 'https://example.invalid/' } } : {}),
      }),
    });
    if (v.jar) {
      writeZip(join(dir, `${v.id}.jar`), [
        { name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\n' },
        { name: 'net/fake/Main.class', data: 'not a class' },
        { name: tex('stone'), data: solidPng(jarColor), method: 'deflate' },
        { name: 'assets/minecraft/textures/item/diamond.png', data: solidPng(jarColor) },
      ]);
    }
  }
  // 资源索引：一个 sounds.json 和一个假的 .ogg
  const soundsJson = JSON.stringify({ 'block.stone.place': { sounds: ['dig/stone1'] } });
  const ogg = 'OggS-fake-sound';
  const objects: Record<string, { hash: string; size: number }> = {
    'minecraft/sounds.json': { hash: 'a'.repeat(40), size: soundsJson.length },
    'minecraft/sounds/dig/stone1.ogg': { hash: 'b'.repeat(40), size: ogg.length },
    '../escape.txt': { hash: 'c'.repeat(40), size: 1 },
  };
  const indexes = new Set(versions.map((v) => v.assetIndex).filter((x): x is string => !!x));
  for (const id of indexes) writeFiles(join(root, 'assets', 'indexes'), { [`${id}.json`]: JSON.stringify({ objects }) });
  writeFiles(join(root, 'assets', 'objects'), {
    [`aa/${'a'.repeat(40)}`]: soundsJson,
    [`bb/${'b'.repeat(40)}`]: ogg,
  });
}

/** 由 ID 散列出的纯色（#rrggbb），让每张假贴图都不一样 */
export function idColor(id: string): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `#${((h >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
}

/**
 * 假原版 jar 的条目：覆盖方块目录、物品目录、界面贴图引用的全部贴图（纯色色块，只是测试数据）。
 * overrides 可以给某些贴图 ID 指定颜色（例如让钻石块是醒目的绿色）。
 */
export function catalogJarEntries(paths: readonly { id: string; path: string }[], overrides: Readonly<Record<string, string>> = {}): ZipEntrySpec[] {
  return [
    { name: 'META-INF/MANIFEST.MF', data: 'Manifest-Version: 1.0\n' },
    { name: 'net/fake/Main.class', data: 'not a class' },
    ...paths.map((p) => ({ name: p.path, data: solidPng(overrides[p.id] ?? idColor(p.id)), method: 'deflate' as const })),
  ];
}

/** 假 .minecraft：一个正式版，jar 里是 catalogJarEntries（没有资源索引，也就没有音效） */
export function makeCatalogGame(gameDir: string, versionId: string, releaseTime: string, entries: readonly ZipEntrySpec[]): void {
  const dir = join(gameDir, 'versions', versionId);
  writeFiles(dir, { [`${versionId}.json`]: JSON.stringify({ id: versionId, type: 'release', releaseTime }) });
  writeZip(join(dir, `${versionId}.jar`), entries);
}
