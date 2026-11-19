import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { JavaSkinLookup, type SkinRequest } from '../../apps/desktop/src/main/skins/java';
import { MAX_SKIN_BYTES } from '../../apps/desktop/src/main/skins/png';
import { IPC_ARGS } from '../../apps/desktop/src/shared/ipc-contract';
import { encodePng } from '../../scripts/mascot-bake/png';

const uuid = '0123456789abcdef0123456789abcdef';
const texture = 'a'.repeat(64);
const name = 'Test_123';
const png = encodePng({ width: 64, height: 64, data: new Uint8Array(64 * 64 * 4) });
const json = (value: unknown) => ({ status: 200, bytes: Buffer.from(JSON.stringify(value)) });
const identity = { id: uuid, name };

function profile(url = `http://textures.minecraft.net/texture/${texture}`, profileId = uuid) {
  return json({ ...identity, properties: [{ name: 'textures', value: json({ profileId, profileName: name, textures: { SKIN: { url, metadata: { model: 'slim' } } } }).bytes.toString('base64') }] });
}

const call = (request: SkinRequest) => new JavaSkinLookup(request).fetch(name);

describe('T-SKIN-2 Java 正版查名契约（假服务，无外网）', () => {
  it('依次访问三个限定 HTTPS 路径，解析窄臂和 PNG；旧 HTTP 字段不会产生 HTTP 请求', async () => {
    const request = vi.fn<SkinRequest>().mockResolvedValueOnce(json(identity)).mockResolvedValueOnce(profile()).mockResolvedValueOnce({ status: 200, bytes: png });
    expect(await call(request)).toEqual({ name, model: 'slim', bytes: png });
    expect(request.mock.calls.map(([url]) => url.href)).toEqual([
      `https://api.mojang.com/users/profiles/minecraft/${name}`,
      `https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`,
      `https://textures.minecraft.net/texture/${texture}`,
    ]);
    expect(request.mock.calls[2]?.[1]).toBe(MAX_SKIN_BYTES);
  });

  it.each([
    `https://other.invalid/texture/${texture}`,
    `https://user@textures.minecraft.net/texture/${texture}`,
    `https://textures.minecraft.net:443/texture/${texture}`,
    `https://textures.minecraft.net/texture/${texture}?extra`,
    `https://textures.minecraft.net/a/../texture/${texture}`,
  ])('拒绝未授权的纹理 URL：%s', async (url) => {
    const request = vi.fn<SkinRequest>().mockResolvedValueOnce(json(identity)).mockResolvedValueOnce(profile(url));
    await expect(call(request)).rejects.toMatchObject({ code: 'invalid-response' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('拒绝档案身份错配、所有重定向及超限响应', async () => {
    const mismatch = vi.fn<SkinRequest>().mockResolvedValueOnce(json(identity)).mockResolvedValueOnce(profile(undefined, 'f'.repeat(32)));
    await expect(call(mismatch)).rejects.toMatchObject({ code: 'invalid-response' });
    expect(mismatch).toHaveBeenCalledTimes(2);
    const redirect = vi.fn<SkinRequest>().mockResolvedValue({ status: 302, bytes: Buffer.alloc(0) });
    await expect(call(redirect)).rejects.toMatchObject({ code: 'invalid-response' });
    expect(redirect).toHaveBeenCalledTimes(1);
    const oversize = vi.fn<SkinRequest>().mockResolvedValueOnce(json(identity)).mockResolvedValueOnce(profile()).mockResolvedValueOnce({ status: 200, bytes: Buffer.alloc(MAX_SKIN_BYTES + 1) });
    await expect(call(oversize)).rejects.toMatchObject({ code: 'too-large' });
  });

  it('总时限中止任务，找不到玩家时不查询档案', async () => {
    const hold = vi.fn<SkinRequest>((_url, _limit, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    await expect(new JavaSkinLookup(hold, 10).fetch(name)).rejects.toMatchObject({ code: 'offline' });
    expect(hold).toHaveBeenCalledTimes(1);
    const missing = vi.fn<SkinRequest>().mockResolvedValue({ status: 404, bytes: Buffer.alloc(0) });
    await expect(call(missing)).rejects.toMatchObject({ code: 'not-found' });
    expect(missing).toHaveBeenCalledTimes(1);
  });

  it('IPC 不接收路径、URL、或调用方伪造的同意参数', () => {
    expect(IPC_ARGS['skins:fetchJava'].safeParse([name, 'en']).success).toBe(true);
    expect(IPC_ARGS['skins:fetchJava'].safeParse([name, 'en', true]).success).toBe(false);
    expect(IPC_ARGS['skins:fetchJava'].safeParse(['https://invalid.test/a', 'en']).success).toBe(false);
    expect(IPC_ARGS['skins:importPng'].safeParse(['classic', 'C:\\somewhere.png']).success).toBe(false);
    expect(IPC_ARGS['skins:read'].safeParse(['skins:../../outside']).success).toBe(false);
  });
});
