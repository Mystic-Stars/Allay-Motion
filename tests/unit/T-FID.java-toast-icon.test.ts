import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ease, math, segment } from '../../packages/engine/src/ease';
import { createItemHandle } from '../../packages/engine/src/items';
import { EngineResources } from '../../packages/engine/src/resources';
import type { SetupContext } from '../../packages/template-sdk/src/index';
import { setupJavaToast } from '../../packages/templates/advancement-toast/src/java-toast';

const requireEngine = createRequire(new URL('../../packages/engine/package.json', import.meta.url));
const THREE = await import(pathToFileURL(requireEngine.resolve('three').replace(/three\.cjs$/, 'three.module.js')).href) as SetupContext['THREE'];
const panelId = 'minecraft:gui/sprites/toast/advancement';
const iconWidth = 16;
const panelWidth = 160;
const panelHeight = 32;
const diamond = 'minecraft:diamond';

const pixel = (x: number, y: number) => [x * 13, y * 15, (x * 9 + y * 11) % 256, (x + 2 * y) % 4 ? 255 : 0];
const iconData = Uint8Array.from({ length: iconWidth ** 2 * 4 }, (_, index) => pixel(Math.floor(index / 4) % iconWidth, Math.floor(index / (4 * iconWidth)))[index % 4]!);
const panelData = Uint8Array.from({ length: panelWidth * panelHeight * 4 }, (_, index) => index % 4 === 3 ? 255 : 33);

async function toast(icon: string, profile: 'javaAdvancement' | 'javaAdvancement263' | 'javaAchievement') {
  const warnings = vi.fn();
  const requests: string[] = [];
  const resources = new EngineResources(async (kind, id) => {
    if (kind !== 'texture') return null;
    requests.push(id);
    if (id === panelId) return { kind: 'rgba', width: panelWidth, height: panelHeight, data: panelData };
    if (id.startsWith('minecraft:item/') || id.startsWith('minecraft:block/')) return { kind: 'rgba', width: iconWidth, height: iconWidth, data: iconData };
    return null;
  }, vi.fn());
  const unexpected = (): never => { throw new Error('非预期接口'); };
  const scene = new THREE.Scene();
  const stage = { width: 480, height: 270, aspect: 16 / 9, fps: 60, pixelScale: 1 };
  const ctx: SetupContext = {
    THREE, scene, stage, locale: 'zh-CN', params: { icon, guiScale: 1, javaTitle: '钻石！' }, warn: warnings, audio: { cue() {} },
    camera: new THREE.OrthographicCamera(-240, 240, 135, -135), setCamera: unexpected, createStageCamera: unexpected,
    resources: { optionalTexture: (id) => resources.optionalTexture(id), item: (id) => createItemHandle(resources, id, warnings), texture: unexpected, block: unexpected },
    text: { prepare: async () => undefined, measureGui: () => ({ width: 30, advance: 30, left: 0, above: 7, below: 1 }), create: () => {
      const group = new THREE.Group();
      group.add(new THREE.Mesh(new THREE.PlaneGeometry(30, 8), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })));
      return { object: group, width: 30, height: 8, setOpacity() {} };
    } },
    sprite: { create: unexpected }, random: unexpected, noise2D: unexpected, ease, math, time: { segment },
  };
  const instance = await setupJavaToast(ctx, profile);
  instance.update(1);
  scene.updateMatrixWorld(true);
  const root = scene.children[0]!;
  const mesh = root.children.at(-1);
  if (!(mesh instanceof THREE.Mesh)) throw new Error('图标没有走实际物品网格');
  return { mesh, root, requests, warnings, resources };
}

describe('T-FID.java-toast-icon', () => {
  it.each(['javaAdvancement', 'javaAdvancement263'] as const)('%s 的钻石保持原 UV，且图标在面板和文字之后绘制', async (profile) => {
    const { mesh, root, requests, warnings, resources } = await toast(diamond, profile);
    try {
      expect(requests).toEqual(profile === 'javaAdvancement' ? ['minecraft:gui/toasts', panelId, 'minecraft:item/diamond'] : [panelId, 'minecraft:item/diamond']);
      expect(warnings).not.toHaveBeenCalled();
      expect(root.position.toArray()).toEqual([160, 119, 0]);
      const [panel, header, title] = root.children;
      if (!(panel instanceof THREE.Mesh) || !(panel.material instanceof THREE.MeshBasicMaterial)) throw new Error('未载入真实面板网格');
      expect(panel.material.transparent).toBe(true);
      expect([panel.renderOrder, header!.children[0]!.renderOrder, title!.children[0]!.renderOrder, mesh.renderOrder]).toEqual([0, 1, 1, 2]);
      expect([root.renderOrder, header!.renderOrder, title!.renderOrder]).toEqual([0, 0, 0]);
      expect(panel.material.depthWrite).toBe(false);
      if (!(mesh.material instanceof THREE.MeshBasicMaterial) || mesh.material.map === null) throw new Error('未载入图标贴图');
      expect(mesh.material.transparent).toBe(true);
      expect(mesh.material.toneMapped).toBe(false);
      expect(mesh.material.depthWrite).toBe(true);
      expect(mesh.material.alphaTest).toBe(0.5);
      const color = mesh.geometry.getAttribute('color');
      expect(Array.from(color.array.slice(0, 12))).toEqual(Array<number>(12).fill(1));
      const image = mesh.material.map.image as { data: Uint8Array; width: number; height: number };
      const raycaster = new THREE.Raycaster();
      const direction = new THREE.Vector3(0, 0, -1);
      for (let row = 0; row < 16; row++) for (let col = 0; col < 16; col++) {
        raycaster.set(new THREE.Vector3(80 + 8 + col + 0.5, 135 - 8 - row - 0.5, 100), direction);
        const hit = raycaster.intersectObject(mesh, false)[0];
        expect(hit?.uv, `${col},${row}`).toBeDefined();
        const offset = (Math.floor(hit!.uv!.y * image.height) * image.width + Math.floor(hit!.uv!.x * image.width)) * 4;
        expect([...image.data.slice(offset, offset + 4)], `${col},${row}`).toEqual(pixel(col, row));
      }
    } finally { resources.dispose(); }
  });

  it.each(['javaAdvancement', 'javaAdvancement263'] as const)('%s 的钻石块保留六面，角点与原版 GUI 矩阵一致', async (profile) => {
    const { mesh, requests, warnings, resources } = await toast('minecraft:diamond_block', profile);
    try {
      expect(requests.at(-1)).toBe('minecraft:block/diamond_block');
      expect(warnings).not.toHaveBeenCalled();
      expect(mesh.geometry.getAttribute('position').count).toBe(24);
      const expected = [[7.071, 4.330], [0, 0.795], [7.071, -4.330], [0, -7.866], [0, 7.866], [-7.071, 4.330], [0, -0.795], [-7.071, -4.330]];
      let corner = 0;
      for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) {
        const projected = mesh.localToWorld(new THREE.Vector3(x, y, z));
        expect(projected.x - 96).toBeCloseTo(expected[corner]![0]!, 3);
        expect(119 - projected.y).toBeCloseTo(expected[corner]![1]!, 3);
        expect(projected.z).toBeGreaterThan(3);
        corner++;
      }
    } finally { resources.dispose(); }
  });

  it('特殊物品不套用立方体姿态或盲猜静态贴图路径', async () => {
    const { mesh, requests, warnings, resources } = await toast('minecraft:shield', 'javaAdvancement263');
    try {
      expect(mesh.rotation.toArray().slice(0, 3)).toEqual([0, 0, 0]);
      expect(mesh.scale.toArray()).toEqual([16, 16, 1]);
      expect(requests).toEqual([panelId]);
      expect(warnings).toHaveBeenCalledWith(expect.stringContaining('shield is not in the item catalog'));
    } finally { resources.dispose(); }
  });
});
