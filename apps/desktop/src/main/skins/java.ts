import { get } from 'node:https';
import { z } from 'zod';
import { JavaNameSchema, type SkinModel } from '../../shared/skins';
import { SkinError } from './errors';
import { MAX_SKIN_BYTES } from './png';

const NAME_HOST = 'api.mojang.com';
const PROFILE_HOST = 'sessionserver.mojang.com';
const TEXTURE_HOST = 'textures.minecraft.net';
const JSON_LIMIT = 32 * 1024;
const UUID = z.string().regex(/^[0-9a-f]{32}$/i);
const ProfileName = z.object({ id: UUID, name: JavaNameSchema });
const Profile = ProfileName.extend({ properties: z.array(z.object({ name: z.string(), value: z.string().max(16_384) })).max(16) });
const Textures = z.object({
  profileId: UUID,
  profileName: JavaNameSchema,
  textures: z.object({ SKIN: z.object({ url: z.string().max(256), metadata: z.object({ model: z.enum(['classic', 'slim']).optional() }).optional() }).optional() }),
});
const Base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/);

interface ResponseBody { status: number; bytes: Buffer }
export type SkinRequest = (url: URL, byteLimit: number, signal: AbortSignal) => Promise<ResponseBody>;

const requestSkinBytes: SkinRequest = (url, byteLimit, signal) => new Promise((resolve, reject) => {
  const request = get(url, { signal, agent: false, rejectUnauthorized: true }, (response) => {
    const status = response.statusCode ?? 0;
    if (status !== 200) {
      response.destroy();
      resolve({ status, bytes: Buffer.alloc(0) });
      return;
    }
    const length = response.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > byteLimit)) {
      response.destroy();
      reject(new SkinError('too-large'));
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    response.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > byteLimit) {
        reject(new SkinError('too-large'));
        response.destroy();
      } else chunks.push(chunk);
    });
    response.on('error', () => reject(new SkinError('offline')));
    response.on('close', () => { if (!response.complete) reject(new SkinError('offline')); });
    response.on('end', () => resolve({ status, bytes: Buffer.concat(chunks) }));
  });
  request.on('error', () => reject(new SkinError('offline')));
});

export class JavaSkinLookup {
  constructor(private readonly request: SkinRequest = requestSkinBytes, private readonly timeoutMs = 12_000) {}

  async fetch(nameInput: string): Promise<{ name: string; model: SkinModel; bytes: Buffer }> {
    const name = JavaNameSchema.parse(nameInput);
    const signal = AbortSignal.timeout(this.timeoutMs);
    const read = async (host: string, path: string, limit: number, missing: 'not-found' | 'no-skin') => {
      signal.throwIfAborted();
      const { status, bytes } = await this.request(new URL(`https://${host}${path}`), limit, signal);
      signal.throwIfAborted();
      if (status === 204 || status === 404) throw new SkinError(missing);
      if (status !== 200) throw new SkinError('invalid-response');
      if (bytes.length > limit) throw new SkinError('too-large');
      return bytes;
    };
    try {
      const found = ProfileName.parse(JSON.parse((await read(NAME_HOST, `/users/profiles/minecraft/${name}`, JSON_LIMIT, 'not-found')).toString('utf8')));
      if (found.name.toLowerCase() !== name.toLowerCase()) throw new SkinError('invalid-response');
      const profile = Profile.parse(JSON.parse((await read(PROFILE_HOST, `/session/minecraft/profile/${found.id}`, JSON_LIMIT, 'not-found')).toString('utf8')));
      if (profile.id !== found.id || profile.name !== found.name) throw new SkinError('invalid-response');
      const properties = profile.properties.filter((property) => property.name === 'textures');
      if (properties.length === 0) throw new SkinError('no-skin');
      if (properties.length !== 1) throw new SkinError('invalid-response');
      const payload = Textures.parse(JSON.parse(Buffer.from(Base64.parse(properties[0]!.value), 'base64').toString('utf8')));
      if (payload.profileId !== found.id || payload.profileName !== found.name) throw new SkinError('invalid-response');
      const skin = payload.textures.SKIN;
      if (!skin) throw new SkinError('no-skin');
      // 历史响应里的 http 只用于提取纹理键，绝不按响应里的 URL 发请求。
      const key = /^https?:\/\/textures\.minecraft\.net\/texture\/([0-9a-f]{32,64})$/.exec(skin.url)?.[1];
      if (!key) throw new SkinError('invalid-response');
      const bytes = await read(TEXTURE_HOST, `/texture/${key}`, MAX_SKIN_BYTES, 'no-skin');
      return { name: found.name, model: skin.metadata?.model ?? 'classic', bytes };
    } catch (error) {
      if (signal.aborted) throw new SkinError('offline');
      if (error instanceof SkinError) throw error;
      throw new SkinError('invalid-response');
    }
  }
}
