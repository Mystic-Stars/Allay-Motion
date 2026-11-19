import type { TemplateModule } from '@allay/template-sdk';
import { sampleMotion, type Action, type Edition } from './motion';
import { buildRig } from './rig';

const template: TemplateModule = {
  async setup(ctx) {
    const { params, THREE, stage, scene } = ctx;
    const duration = typeof params.duration === 'number' ? params.duration : 3;
    const skin = params.skin;
    if (typeof skin !== 'string' || !skin.startsWith('skins:')) return { duration, update() {} };
    const source = await ctx.resources.texture(skin);
    const image = source.image;
    if (typeof image !== 'object' || image === null || !('width' in image) || !('height' in image) ||
      image.width !== 64 || (image.height !== 32 && image.height !== 64) || !('data' in image) || !(image.data instanceof Uint8Array)) {
      ctx.warn(ctx.locale?.startsWith('zh') ? '皮肤不可用或尺寸不符；不绘制角色。' : 'The skin is unavailable or has invalid dimensions. No character is drawn.');
      return { duration, update() {} };
    }
    const texture = new THREE.DataTexture(image.data, image.width, image.height);
    texture.colorSpace = source.colorSpace;
    texture.magFilter = source.magFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    const rig = buildRig(THREE, texture, image.height, params.armModel === 'slim');
    const action: Action = params.action === 'idle' || params.action === 'sprint' || params.action === 'jump' ? params.action : 'walk';
    const edition: Edition = params.edition === 'bedrock' ? 'bedrock' : 'java';
    const bob = typeof params.bob === 'number' ? params.bob : 0.5;
    const thirdPerson = params.view !== 'first';
    const angle = (typeof params.orbit === 'number' ? params.orbit : 28) * Math.PI / 180;
    const fov = typeof params.fov === 'number' ? params.fov : 50;
    const camera = new THREE.PerspectiveCamera(fov, stage.aspect, 0.1, 350);
    const distance = 22 / Math.tan(fov * Math.PI / 360) / Math.min(1, stage.aspect * 1.6);
    scene.add(camera);
    ctx.setCamera(camera);
    const viewArm = thirdPerson ? null : rig.makeViewArm();
    scene.add(rig.root);
    if (viewArm) {
      camera.add(viewArm);
      viewArm.scale.set(0.68, 0.68, 0.68);
    }
    const edge = 1 / stage.fps;
    const end = (Math.ceil(duration * stage.fps - 1e-6) - 1) / stage.fps - edge / 2;
    return {
      duration,
      dispose: () => texture.dispose(),
      update(t) {
        const pose = sampleMotion(action === 'jump' && duration < 1 ? t / duration : t, action, edition, bob);
        const visible = t > edge / 2 && t < end;
        rig.root.visible = thirdPerson && visible;
        rig.root.position.y = pose.lift;
        rig.upper.rotation.x = pose.lean;
        rig.head.rotation.set(-pose.lean * 0.55, pose.headYaw, 0);
        rig.rightArm.rotation.set(pose.rightArm, 0, -0.035);
        rig.leftArm.rotation.set(pose.leftArm, 0, 0.035);
        rig.rightLeg.rotation.x = pose.rightLeg;
        rig.leftLeg.rotation.x = pose.leftLeg;
        if (viewArm) {
          camera.position.set(pose.bobX, 27.5 + pose.lift + pose.bobY, 3);
          camera.lookAt(pose.bobX, 25 + pose.lift + pose.bobY, 30);
          camera.rotateZ(pose.roll);
          viewArm.visible = visible;
          const halfHeight = Math.tan(fov * Math.PI / 360) * 10;
          viewArm.position.set(halfHeight * stage.aspect * 0.70 - pose.bobX * 0.45, -halfHeight * 0.77 - pose.bobY * 0.5, -10);
          viewArm.rotation.set(0.83 + pose.rightArm * 0.38, -0.23, -0.18 + pose.roll);
        } else {
          camera.position.set(Math.sin(angle) * distance + pose.bobX, 23 + pose.lift * 0.75 + pose.bobY, Math.cos(angle) * distance);
          camera.lookAt(0, 16 + pose.lift * 0.75, 0);
          camera.rotateZ(pose.roll * 0.45);
        }
      },
    };
  },
};

export default template;
