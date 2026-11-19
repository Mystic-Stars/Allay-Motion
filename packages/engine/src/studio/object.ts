import type { TemplateModule } from '@allay/template-sdk';

const template: TemplateModule = {
  async setup({ params, scene, stage, THREE, resources, text, audio }) {
    const shortSide = Math.min(stage.width, stage.height);
    let stillTexture: InstanceType<typeof THREE.DataTexture> | undefined;
    switch (params.kind) {
      case 'image': {
        if (typeof params.image !== 'string' || params.image === '') break;
        const map = await resources.texture(params.image);
        const image = map.image;
        if (!image || typeof image !== 'object' || !('width' in image) || !('height' in image)) break;
        const width = Number(image.width) * map.repeat.x;
        const height = Number(image.height) * map.repeat.y;
        if (!(width > 0 && height > 0)) break;
        const scale = shortSide * 0.6 / Math.max(width, height);
        if ((map.repeat.x !== 1 || map.repeat.y !== 1) && 'data' in image && image.data instanceof Uint8Array) {
          stillTexture = new THREE.DataTexture(image.data, Number(image.width), Number(image.height));
          stillTexture.repeat.copy(map.repeat);
          stillTexture.offset.copy(map.offset);
          stillTexture.colorSpace = map.colorSpace;
          stillTexture.magFilter = map.magFilter;
          stillTexture.minFilter = map.minFilter;
          stillTexture.generateMipmaps = map.generateMipmaps;
          stillTexture.needsUpdate = true;
        }
        const geometry = new THREE.PlaneGeometry(width * scale, height * scale);
        const material = new THREE.MeshBasicMaterial({ map: stillTexture ?? map, transparent: true, depthWrite: false });
        scene.add(new THREE.Mesh(geometry, material));
        break;
      }
      case 'text': {
        if (typeof params.text !== 'string' || params.text.trim() === '') break;
        scene.add(text.create({
          text: params.text,
          font: String(params.font),
          size: Number(params.textSize),
          color: String(params.color),
          shadow: params.shadow === true,
          align: 'center',
          maxWidth: stage.width * 0.8,
        }).object);
        break;
      }
      case 'block': {
        const block = (await resources.block(String(params.block))).single();
        block.scale.setScalar(shortSide * 0.28);
        block.rotation.set(Math.PI / 8, -Math.PI / 5, 0, 'YXZ');
        scene.add(block);
        break;
      }
      case 'sound':
        if (typeof params.sound === 'string') audio.cue(params.sound, 0, { gain: Number(params.gain) });
        break;
    }
    return { duration: 3, update() {}, dispose: () => stillTexture?.dispose() };
  },
};

export default template;
