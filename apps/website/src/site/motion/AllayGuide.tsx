// 带路的悦灵：全页同一时刻只有一只，用的是应用里同一份 3D 烘焙图集和同一个 <Allay> 组件（packages/mascot）。
// - 各节在合适的空白处放一个锚点（data-allay-anchor）；悦灵飞向当前那一节的锚点，随滚动在各节之间飞行；
// - 运动：临界阻尼弹簧（不过冲不抖），水平速度大时用 fly、慢下来切回 hover，朝向跟速度，倾斜与水平速度成正比（±10°），
//   飞行时尾部放出品牌蓝的方点（与 07 7.6 A 同一套：6 个的池子、80 ms 一个、420 ms 淡出）；
// - 对鼠标：停着时朝指针那边看；指针靠得太近时让开一点；
// - 让位：它申请的是最低优先级的位置（MascotStage），应用自己的编排（预览加载、导出进度）一出现，它就让出去；
//   剪辑点的转场进行时、仿真器在视口里时（iframe 里是应用自己的悦灵）它不出场，免得同屏两只；
// - 首屏由 3D 世界用方块拼出一只体素悦灵（motion/world）：拼着、拼好时它不出场（贴在那只的位置上），
//   那只散开时它从那里飞出来带路；首屏给它的锚点带 data-allay-yield，世界会拼体素悦灵时这个锚点不用；
// - 锚点上带 data-allay-clip="dance" 的（页尾）到了就跳一段舞：活干完了，把结果送到，跳舞（07 7.1）；
// - 背景的方块拼出一大块（四块以上）时，飞过去在旁边看一眼（不到两秒）再回自己的锚点；
// - 减少动效：不飞，静止在首屏的锚点旁（hover 的第一帧）。
// 每帧先在读阶段量锚点的位置（只量这几个点），再在写阶段写 transform；pointer-events: none，不挡任何点击。
import { Allay, MascotSlotHeld, mascotAssets, useMascotSlot } from '@allay/mascot';
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { ClipName } from '@allay/mascot';
import { usePrefs } from '../prefs';
import { onFrame, onFrameRead, spring } from './frame';
import { allay3d, onSculptureExpected } from './world/bridge';

const TRAIL = 6;
const TRAIL_EVERY = 80;
const TRAIL_LIFE = 420;

interface Target {
  x: number;
  y: number;
  facing: 'left' | 'right' | null;
  clip: ClipName | null;
}

/** 当前该去哪个锚点（视口坐标）；没有合适的锚点时为 null */
function pickTarget(vh: number): Target | null {
  const focus = vh * 0.42;
  // 禁飞区：剪辑点的转场正在进行、仿真器在视口中线附近
  const overlay = document.querySelector<HTMLElement>('[data-testid="cut-overlay"]');
  if (overlay?.dataset.active === 'true') return null;
  for (const el of document.querySelectorAll<HTMLElement>('[data-allay-nofly]')) {
    const r = el.getBoundingClientRect();
    if (r.top < vh * 0.75 && r.bottom > vh * 0.25) return null;
  }
  let best: { el: HTMLElement; r: DOMRect; d: number } | null = null;
  for (const el of document.querySelectorAll<HTMLElement>('[data-allay-anchor]')) {
    if (allay3d.expected && el.dataset.allayYield !== undefined) continue;
    const step = el.closest<HTMLElement>('[data-step]');
    if (step && step.dataset.active !== 'true') continue;
    // data-allay-until：只在那一节还没走到视口中间之前有效（首屏的锚点在分镜开始后就不用了，免得飞进正在播放的预览）
    const until = el.dataset.allayUntil ? document.getElementById(el.dataset.allayUntil) : null;
    if (until && until.getBoundingClientRect().top < vh * 0.55) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0 && r.top === 0 && r.left === 0) continue; // 不显示的
    if (r.top < vh * 0.06 || r.top > vh * 0.94) continue;
    const d = Math.abs(r.top - focus);
    if (!best || d < best.d) best = { el, r, d };
  }
  if (!best) return null;
  const f = best.el.dataset.allayFacing;
  return { x: best.r.left + best.r.width / 2, y: best.r.top + best.r.height / 2, facing: f === 'left' || f === 'right' ? f : null, clip: (best.el.dataset.allayClip as ClipName | undefined) ?? null };
}

export function AllayGuide() {
  const { reducedMotion } = usePrefs();
  return reducedMotion ? <StillGuide /> : <FlyingGuide />;
}

function FlyingGuide() {
  const granted = useMascotSlot('default');
  const rootRef = useRef<HTMLDivElement>(null);
  const trailRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [pose, setPose] = useState<{ clip: ClipName; facing: 'left' | 'right' }>({ clip: 'fly', facing: 'right' });
  const [size, setSize] = useState(() => (window.innerWidth < 640 ? 60 : 84));
  const [shown, setShown] = useState(false);
  const poseRef = useRef(pose);
  const shownRef = useRef(shown);
  // 3D 世界装好了悦灵的图集时，悦灵改由世界来画（它在那个空间里飞、会被近处的方块挡住），这里只算路径
  const [use3d, setUse3d] = useState(allay3d.ready);
  const use3dRef = useRef(use3d);

  useEffect(() => {
    const onResize = () => setSize(window.innerWidth < 640 ? 60 : 84);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!granted) {
      allay3d.state = null;
      if (shownRef.current) {
        shownRef.current = false;
        setShown(false);
      }
      return;
    }
    const root = rootRef.current;
    if (!root) return;
    let target: Target | null = null;
    // 从左边外面飞进来
    let x = -size;
    let y = window.innerHeight * 0.45;
    let vx = 0;
    let vy = 0;
    let flying = true;
    let lastTrail = 0;
    let trailIdx = 0;
    const trailBorn = new Array<number>(TRAIL).fill(-1e9);
    let danceUntil = 0;
    let lastDanceAnchor = false;
    let clipAt = 0;
    const offRead = onFrameRead((s) => {
      target = pickTarget(s.vh);
      // 背景方块拼出一大块时：飞到那一块的左上方，朝它看一眼（不出场的时候不管）
      const att = allay3d.attention;
      if (target && att && performance.now() < att.until) {
        const left = att.x > s.vw / 2;
        target = { x: att.x + (left ? -90 : 90), y: Math.max(80, att.y - 70), facing: left ? 'right' : 'left', clip: null };
      }
    });
    const offWrite = onFrame((s) => {
      // 世界装好图集后改由世界来画（先同步这个，体素悦灵在场时也要切过去，免得 DOM 里还挂着一只）
      if (allay3d.ready !== use3dRef.current) {
        use3dRef.current = allay3d.ready;
        setUse3d(allay3d.ready);
      }
      // 体素悦灵在场：贴在它的位置上不出场；它散开时从这里飞出去
      const sc = allay3d.sculpture;
      if (sc) {
        x = sc.x;
        y = sc.y;
        vx = 0;
        vy = 0;
        allay3d.state = null;
        if (shownRef.current) {
          shownRef.current = false;
          setShown(false);
        }
        return;
      }
      const t = target;
      let tx: number;
      let ty: number;
      if (t) {
        tx = t.x;
        ty = t.y;
      } else {
        // 没地方去：从近的一侧飞出画面
        tx = x < s.vw / 2 ? -size * 1.5 : s.vw + size * 1.5;
        ty = y;
      }
      // 指针太近就让开一点
      if (s.pointer && t) {
        const dx = x - s.pointer.x;
        const dy = y - s.pointer.y;
        const d = Math.hypot(dx, dy);
        const R = size * 1.4;
        if (d < R && d > 0.001) {
          tx += (dx / d) * (R - d) * 0.9;
          ty += (dy / d) * (R - d) * 0.9;
        }
      }
      [x, vx] = spring(x, vx, tx, 4.2, s.dt);
      [y, vy] = spring(y, vy, ty, 4.2, s.dt);
      const speed = Math.hypot(vx, vy);
      flying = flying ? speed > 70 : speed > 150;
      const tilt = Math.max(-10, Math.min(10, (vx / 700) * 10));
      root.style.transform = `translate3d(${(x - size / 2).toFixed(1)}px, ${(y - size / 2).toFixed(1)}px, 0) rotate(${tilt.toFixed(2)}deg)`;
      const onScreen = x > -size && x < s.vw + size && y > -size && y < s.vh + size;
      if (onScreen !== shownRef.current) {
        shownRef.current = onScreen;
        setShown(onScreen);
      }
      // 动作与朝向
      const danceAnchor = !!t && t.clip === 'dance' && Math.hypot(tx - x, ty - y) < 24;
      if (danceAnchor && !lastDanceAnchor) danceUntil = s.now + 2000;
      lastDanceAnchor = danceAnchor;
      let clip: ClipName = flying ? 'fly' : 'hover';
      if (!flying && s.now < danceUntil) clip = 'dance';
      let facing: 'left' | 'right' = poseRef.current.facing;
      if (Math.abs(vx) > 60) facing = vx > 0 ? 'right' : 'left';
      else if (s.pointer) facing = s.pointer.x < x ? 'left' : 'right';
      else if (t?.facing) facing = t.facing;
      if (clip !== poseRef.current.clip) clipAt = s.now;
      if (clip !== poseRef.current.clip || facing !== poseRef.current.facing) {
        poseRef.current = { clip, facing };
        setPose(poseRef.current);
      }
      // 交给 3D 世界画：图集里的第几帧（动作按图集的 30 fps 步进，和 <Allay> 一样）
      if (allay3d.ready) {
        const assets = mascotAssets();
        if (assets.status === 'ready' && onScreen) {
          const { start, count } = assets.atlas.clips[clip];
          const frame = start + (Math.floor(((s.now - clipAt) / 1000) * assets.atlas.fps) % count);
          allay3d.state = { x, y, size, frame, facing: facing === 'right' ? 1 : -1, tilt };
        } else allay3d.state = null;
        return;
      }
      // 拖尾方点
      if (flying && onScreen && s.now - lastTrail > TRAIL_EVERY) {
        lastTrail = s.now;
        const el = trailRefs.current[trailIdx];
        trailBorn[trailIdx] = s.now;
        if (el) el.dataset.x = `${(x - (vx > 0 ? size * 0.32 : -size * 0.32)).toFixed(1)},${(y + size * 0.12).toFixed(1)}`;
        trailIdx = (trailIdx + 1) % TRAIL;
      }
      for (let i = 0; i < TRAIL; i++) {
        const el = trailRefs.current[i];
        if (!el) continue;
        const age = (s.now - trailBorn[i]!) / TRAIL_LIFE;
        if (age >= 1) {
          if (el.style.opacity !== '0') el.style.opacity = '0';
          continue;
        }
        const [px, py] = (el.dataset.x ?? '0,0').split(',').map(Number);
        el.style.opacity = (0.85 * (1 - age)).toFixed(3);
        el.style.transform = `translate3d(${(px! - 2).toFixed(1)}px, ${(py! - 2).toFixed(1)}px, 0) scale(${(1 - age * 0.6).toFixed(3)})`;
      }
    });
    return () => {
      offRead();
      offWrite();
      allay3d.state = null;
    };
  }, [granted, size]);

  return (
    <div className="pointer-events-none fixed inset-0 z-[45] overflow-hidden" aria-hidden="true" data-testid="allay-guide" data-granted={granted} data-render={use3d ? '3d' : 'dom'} data-shown={granted && shown}>
      {Array.from({ length: TRAIL }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            trailRefs.current[i] = el;
          }}
          className="absolute top-0 left-0 size-1 rounded-[1px] bg-allay-light opacity-0"
        />
      ))}
      <div ref={rootRef} className="absolute top-0 left-0 transition-opacity duration-300" style={{ width: size, height: size, opacity: granted && shown ? 1 : 0} as CSSProperties}>
        {granted && !use3d && (
          <MascotSlotHeld.Provider value={true}>
            <Allay clip={pose.clip} size={size} facing={pose.facing} priority="default" />
          </MascotSlotHeld.Provider>
        )}
      </div>
    </div>
  );
}

/** 减少动效：静止在首屏锚点旁（随页面滚动，不飞） */
function StillGuide() {
  const granted = useMascotSlot('default');
  // 世界画着静止的体素悦灵时，这只让给它
  const yielded = useSyncExternalStore(onSculptureExpected, () => allay3d.expected);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const place = () => {
      const a = document.querySelector<HTMLElement>('[data-allay-anchor="hero"]');
      if (!a) return;
      const r = a.getBoundingClientRect();
      setPos({ x: r.left + window.scrollX, y: r.top + window.scrollY });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, []);
  if (!pos || !granted || yielded) return null;
  const size = 72;
  return (
    <div className="pointer-events-none absolute top-0 left-0 z-[45]" style={{ transform: `translate(${pos.x - size / 2}px, ${pos.y - size / 2}px)`, width: size, height: size }} aria-hidden="true" data-testid="allay-guide">
      <MascotSlotHeld.Provider value={true}>
        <Allay clip="hover" size={size} facing="right" priority="default" />
      </MascotSlotHeld.Provider>
    </div>
  );
}
