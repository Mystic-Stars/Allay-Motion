import type { ParamValue, SetupContext, TemplateInstance, TextObject } from '@allay/template-sdk';
import { createJavaBackground, JAVA_TEXTURES, javaGuiScale, javaTexture, warnJavaAsset, type JavaBackdrop } from './java-background';
import { JAVA_CHUNKS, VERTEX } from './visuals';
import { tickSmoothedProgress } from './java-optics';
import { javaLoadingCopy } from './java-copy';
import { fitJavaGuiLine } from './java-text-layout';

export interface JavaLoadingProfile {
  scene: 'startup' | 'reload' | 'world' | 'dimension';
  background: JavaBackdrop;
  layout: 'splash' | 'reload' | 'percent' | 'chunkBar' | 'terrain';
  grid?: number;
  targetGrid?: number;
  gap?: number;
  modern?: boolean;
}

const PALETTE_1211 = ['#545454', '#999999', '#5F6191', '#80B252', '#D1D1D1', '#726809', '#303572', '#21C600', '#CCCCCC', '#FFE0A0', '#F26060', '#FFFFFF'];
const PALETTE_263 = PALETTE_1211.filter((_, index) => index !== 4 && index !== 5);
const numberOr = (value: ParamValue | undefined, fallback: number) => typeof value === 'number' ? value : fallback;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const RED_LOGO_UV = [
  [-0.0625 / 120, 0, 119.9375 / 120, 0.5],
  [0.0625 / 120, 0.5, 120.0625 / 120, 1],
] as const;

function splashGeometry(guiW: number, guiH: number, white: boolean) {
  const centerX = Math.floor(guiW / 2);
  const centerY = Math.floor(guiH / 2);
  const logoHeight = Math.min(guiW * 0.75, guiH) / 4;
  const half = Math.floor(logoHeight * 2);
  return white
    ? { centerX, logoTop: centerY - 128, logoWidth: 256, logoHeight: 256, barWidth: 300, barTop: Math.floor(guiH / 4) * 3 }
    : { centerX, logoTop: centerY - Math.floor(logoHeight / 2), logoWidth: half * 2, logoHeight: Math.floor(logoHeight), barWidth: half * 2, barTop: Math.floor(guiH * 0.8325) - 5 };
}

export async function setupJavaLoading(
  ctx: SetupContext,
  profile: JavaLoadingProfile,
  sampleProgress: (mode: 'resource' | 'chunks', fraction: number) => number,
): Promise<TemplateInstance> {
  const { THREE, stage, params } = ctx;
  const { width, height, fps } = stage;
  const inDuration = numberOr(params.inDuration, 0.3);
  const hold = numberOr(params.hold, 0.9);
  const outDuration = numberOr(params.outDuration, 0.3);
  const duration = inDuration + hold + outDuration;
  const cutTime = inDuration + hold * clamp01(numberOr(params.cutAt, 0.5));
  const pad = 1 / fps;
  const inStart = Math.min(pad, inDuration / 2);
  const inEnd = Math.max(inStart + 1e-4, Math.min(inDuration, cutTime - pad));
  const outEnd = duration - Math.min(pad, outDuration / 2);
  const outStart = Math.min(Math.max(inDuration + hold, cutTime + pad), outEnd - 1e-4);
  const motion = params.animateBackground !== false;
  const showBar = params.showBar !== false;
  const language = params.loadingLanguage === 'auto' || !params.loadingLanguage ? ctx.locale : params.loadingLanguage;
  const chinese = typeof language === 'string' && language.toLowerCase().startsWith('zh');
  const { title, subtitle, overrideBarColor } = javaLoadingCopy(params);

  const unit = javaGuiScale(width, height);
  const guiW = Math.floor(width / unit + 1e-6);
  const guiH = Math.floor(height / unit + 1e-6);
  const centerX = Math.floor(guiW / 2);
  const centerY = Math.floor(guiH / 2);
  const root = new THREE.Group();
  const quad = new THREE.PlaneGeometry(1, 1);
  const redOrWhite = profile.layout === 'splash' || profile.layout === 'reload';
  const background = await createJavaBackground(ctx, profile.background, profile.modern === true, unit);
  const backdrop = new THREE.Mesh(quad, background.material);
  backdrop.scale.set(width + 2, height + 2, 1);
  backdrop.renderOrder = -2;
  root.add(backdrop);
  ctx.scene.add(root);

  const materials: InstanceType<typeof THREE.Material>[] = [];
  const fillOpacity = new Map<InstanceType<typeof THREE.Material>, number>();
  const geometries: InstanceType<typeof THREE.BufferGeometry>[] = [quad];
  const textRoot = new THREE.Group();
  root.add(textRoot);
  const texts: TextObject[] = [];
  const position = (object: InstanceType<typeof THREE.Object3D>, x: number, y: number, z: number) => {
    object.position.set(x * unit - width / 2, height / 2 - y * unit, z);
  };
  const place = <T extends InstanceType<typeof THREE.Material>>(mat: T, left: number, top: number, w: number, h: number, z: number, geometry = quad) => {
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.scale.set(w * unit, h * unit, 1);
    position(mesh, left + w / 2, top + h / 2, z);
    mesh.renderOrder = z;
    root.add(mesh);
    materials.push(mat);
    return mesh;
  };
  const rect = (color: string, left: number, top: number, w: number, h: number, z = 3) => place(
    new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, toneMapped: false }), left, top, w, h, z,
  );
  const progressRect = (defaultColor: string, left: number, top: number, height: number, z: number) => {
    const bar = rect(overrideBarColor?.slice(0, 7) ?? defaultColor, left, top, 0, height, z);
    if (overrideBarColor?.length === 9 && !Array.isArray(bar.material)) fillOpacity.set(bar.material, Number.parseInt(overrideBarColor.slice(7), 16) / 255);
    return bar;
  };
  const label = (text: string, top: number, font: ParamValue | undefined, bandTop: number, bandBottom: number) => {
    const line = text.split(/[\r\n]/u, 1)[0]!;
    if (!line.trim()) return null;
    const fontId = typeof font === 'string' ? font : 'minecraft:default';
    const layout = fitJavaGuiLine(ctx.text.measureGui(line, fontId), numberOr(params.textScale, 5) / 5, centerX, guiW, top + 7, bandTop, bandBottom);
    if (!layout) return null;
    const color = typeof params.textColor === 'string' ? params.textColor : '#FFFFFF';
    const obj = ctx.text.create({ text: line, size: unit * layout.scale, color, align: 'left', shadow: true, font: fontId, origin: 'guiBaseline' });
    position(obj.object, layout.penX, layout.baseline, 5);
    textRoot.add(obj.object);
    texts.push(obj);
    return obj;
  };
  const grid = profile.grid ?? 0;
  const gap = profile.gap ?? 0;
  const gridEdge = grid * (2 + gap) - gap;
  const gridTop = centerY - Math.floor(gridEdge / 2);
  const gridBottom = gridTop + gridEdge;
  let fill: ((progress: number) => void) | undefined;
  const splashLogo: InstanceType<typeof THREE.Material>[] = [];
  let splashBar: InstanceType<typeof THREE.Material>[] = [];
  let percentages: (TextObject | null)[] = [];
  const palette = profile.modern ? PALETTE_263 : PALETTE_1211;
  const gridUniforms = {
    side: { value: grid }, target: { value: profile.targetGrid ?? grid }, gap: { value: profile.gap ?? 0 },
    statusCount: { value: palette.length },
    palette: { value: Array.from({ length: 12 }, (_, index) => new THREE.Color(palette[index] ?? '#FFFFFF')) },
    progress: { value: 0 }, opacity: { value: 1 },
  };

  if (redOrWhite) {
    const white = profile.background === 'white';
    const id = white ? JAVA_TEXTURES.logoWhite : JAVA_TEXTURES.logoRed;
    const logo = await javaTexture(ctx, id);
    const geometry = splashGeometry(guiW, guiH, white);
    const { logoTop, logoWidth, logoHeight, barWidth, barTop } = geometry;
    if (logo) {
      const halves = white ? [[0, 0, 1, 1] as const] : RED_LOGO_UV;
      for (const [index, [u0, v0, u1, v1]] of halves.entries()) {
        const face = new THREE.PlaneGeometry(1, 1);
        face.setAttribute('uv', new THREE.Float32BufferAttribute([u0, 1 - v0, u1, 1 - v0, u0, 1 - v1, u1, 1 - v1], 2));
        geometries.push(face);
        const part = logoWidth / halves.length;
        const material = new THREE.MeshBasicMaterial({ map: logo, transparent: true, depthWrite: false, toneMapped: false });
        splashLogo.push(material);
        place(material,
          centerX - logoWidth / 2 + index * part, logoTop, part, logoHeight, 2, face);
      }
    } else warnJavaAsset(ctx, id, 'omitting the logo', '省略字标');
    if (title?.trim()) label(title, Math.max(4, Math.min(logoTop - 14, 32)), params.titleFont, 2, Math.max(17, logoTop - 1));
    if (subtitle.trim()) label(subtitle, Math.min(guiH - 20, barTop + 13), params.subtitleFont, barTop + 12, guiH - 2);

    if (showBar) {
      const firstMaterial = materials.length;
      const color = white ? '#000000' : '#FFFFFF';
      const left = centerX - barWidth / 2;
      const inset = white ? 1 : 2;
      rect(color, left + (white ? -1 : 1), barTop - (white ? 1 : 0), barWidth + (white ? 2 : -2), 1);
      rect(color, left + (white ? -1 : 1), barTop + (white ? 10 : 9), barWidth + (white ? 2 : -2), 1);
      rect(color, left - (white ? 1 : 0), barTop, 1, 10);
      rect(color, left + barWidth - (white ? 0 : 1), barTop, 1, 10);
      const bar = progressRect(white ? '#E22837' : color, left + inset, barTop + inset, 10 - inset * 2, 3);
      splashBar = materials.slice(firstMaterial);
      fill = (progress) => {
        const w = Math.max(0, Math.ceil((barWidth - 2) * progress) - inset);
        bar.visible = w > 0;
        bar.scale.x = w * unit;
        position(bar, left + inset + w / 2, barTop + 5, 3);
      };
    }
  } else {
    if (grid) {
      place(new THREE.ShaderMaterial({ uniforms: gridUniforms, vertexShader: VERTEX, fragmentShader: JAVA_CHUNKS, transparent: true, depthWrite: false }),
        centerX - Math.floor(gridEdge / 2), gridTop, gridEdge, gridEdge, 1);
    }
    const captionTop = grid ? gridBottom + 7 : centerY - 34;
    if (profile.layout === 'percent') {
      const top = centerY - Math.floor(grid * (2 + gap) / 2) - 11;
      const hasTitle = !!title?.trim();
      if (title?.trim()) label(title, top - 15, params.titleFont, 2, showBar ? top - 3 : gridTop - 1);
      if (showBar) percentages = Array.from({ length: 101 }, (_, percentage) => label(`${percentage}%`, top, params.progressFont, hasTitle ? top - 2 : 2, gridTop - 1));
    } else {
      const top = centerY - (grid ? grid - 1 + 27 : 50);
      const heading = title ?? (chinese ? '加载地形中…' : 'Loading terrain...');
      const barTop = top + 12;
      const headingBottom = grid ? (showBar && profile.layout === 'chunkBar' ? barTop - 1 : gridTop - 1)
        : (subtitle.trim() ? captionTop - 1 : guiH - 2);
      label(heading, top, params.titleFont, 2, headingBottom);
      if (showBar && profile.layout === 'chunkBar') {
        const left = centerX - 100;
        rect('#000000', left, barTop, 200, 2);
        const bar = progressRect('#00FF00', left, barTop, 2, 4);
        fill = (progress) => {
          const w = Math.round(progress * 200);
          bar.visible = w > 0;
          bar.scale.x = w * unit;
          position(bar, left + w / 2, barTop + 1, 4);
        };
      }
    }
    if (subtitle.trim()) label(subtitle, captionTop, params.subtitleFont, grid ? gridBottom + 1 : captionTop, guiH - 2);
  }

  const resourceOrChunks = redOrWhite ? 'resource' as const : 'chunks' as const;
  const targetAt = (time: number) => sampleProgress(resourceOrChunks, (time - inDuration) / hold);

  return {
    duration,
    cutTime,
    update(time) {
      const entering = time <= cutTime;
      const phase = entering ? clamp01((time - inStart) / (inEnd - inStart)) : clamp01((time - outStart) / (outEnd - outStart));
      const shown = entering ? phase : 1 - phase;
      const style = entering ? params.inStyle : params.outStyle;
      const sliding = style === 'slideUp';
      const dissolving = style === 'dissolve';
      const opacity = sliding ? 1 : shown;
      root.visible = shown > 0;
      root.position.y = sliding ? (height + 2) * (entering ? ctx.ease.cubicOut(phase) - 1 : ctx.ease.cubicIn(phase)) : 0;
      const splashFade = redOrWhite && !sliding && !dissolving;
      const entryAlpha = Math.min(1, opacity * 2);
      const bgOpacity = !splashFade ? opacity : entering
        ? (profile.scene === 'startup' ? entryAlpha : (0.15 + opacity * 0.85) * entryAlpha) : Math.min(1, opacity * 2);
      background.update(time, motion, dissolving ? 1 : bgOpacity, phase, dissolving ? (entering ? 1 : -1) : 0);
      const progress = targetAt(time);
      gridUniforms.progress.value = progress;
      gridUniforms.opacity.value = opacity;
      for (const mat of materials) mat.opacity = opacity;
      if (splashFade) {
        for (const mat of splashLogo) mat.opacity = entering ? (profile.scene === 'startup' ? entryAlpha : opacity) : bgOpacity;
        for (const mat of splashBar) mat.opacity = entering ? entryAlpha : clamp01(1 - phase * 2);
      }
      for (const [material, factor] of fillOpacity) material.opacity *= factor;
      if (fill) fill(profile.layout === 'chunkBar' ? tickSmoothedProgress(time, 0.2, targetAt) : progress);
      for (const text of texts) text.setOpacity(opacity);
      const percent = Math.floor(progress * 100);
      for (const [index, text] of percentages.entries()) if (text) text.object.visible = index === percent;
    },
    dispose() {
      textRoot.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const textMaterials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of textMaterials) material.dispose();
      });
      root.removeFromParent();
      background.dispose();
      for (const material of materials) material.dispose();
      for (const geometry of geometries) geometry.dispose();
    },
  };
}
