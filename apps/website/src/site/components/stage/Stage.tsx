// 首屏 + 分镜（工作流）。滚动只负责正常经过这两节，动画都是“到了就自己按时间播完”，不按滚动位置逐帧驱动：
// - 首屏：超大标题在左上，预览面板斜着躺在右下（3D 透视、跟鼠标微微转动），方块在四周悬浮；
// - 走进“工作流”这一节（它的上沿过了视口 60%），面板自己用约 0.8 秒立起来、移到右栏（带阻尼的弹簧，停手也会走到终态）；
//   往回滚到首屏，面板同样自己躺回去。滚得很快、这一段不在视口里时直接落到终态，不补播；
// - 分镜三步（选模板 → 调参数 → 导出）进了视口就按时间依次自动播放，每一步可以用标签页点击或键盘切换；
//   ②调参数时引擎 setParams 实时重画，③导出时预览的播放头停在正在渲染的那一帧，悦灵用应用的导出进度编排。
//   离开视口就暂停，回来从这一步的开头重新播（不从半截续上）。
// 只有一层 sticky 的背景（3D 场景和面板），文字照常滚动；没有“多滚几屏才能过去”的吸顶段落。减少动效时换成静态的排版。
import { localize, type ParamValues } from '@allay/template-sdk';
import { buttonVariants } from '@allay/ui/components/button';
import { Tabs, TabsList, TabsTrigger } from '@allay/ui/components/tabs';
import { ArrowDown, GithubLogo } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { defaultCutTime, defaultDuration, showcaseEntries } from '../../../host/templates';
import { REPO_URL, SECTION } from '../../links';
import { clamp01, easeInOutCubic, lerp, onFrame, spring, track } from '../../motion/frame';
import { usePrefs } from '../../prefs';
import { LiveViewer, type LiveViewerControl } from '../LiveViewer';
import { ExportPanel, TunePanel, type TuneValues } from './panels';
import type { AllayProgressPhase } from '@allay/mascot';

const TUNED = 'allay.builtin.block-wipe';
const STEPS = ['pick', 'tune', 'export'] as const;
type Step = (typeof STEPS)[number];
/** 第一步里依次换的模板个数（展示顺序的前几个；模板再多也只换这几个，其余在模板一节和仿真器里） */
const PICK_COUNT = 4;
/** 每一步自动播放的时长（毫秒）：①每个模板停 1.3 秒 ②参数走 3 秒再停一会儿 ③渲染、封装、完成后停住 */
const PICK_EACH_MS = 1300;
const STEP_MS = [PICK_COUNT * PICK_EACH_MS + 300, 4800, 6600] as const;

interface Story {
  step: number;
  pick: number;
  tune: TuneValues;
  frame: number;
  phase: AllayProgressPhase;
}

const PATTERNS = ['centerOut', 'diagonal', 'bottomToTop'];
const TUNE_START: TuneValues = { cols: 6, inPattern: 'centerOut', spin: 'flipY' };

/** 第 step 步开始后 ms 毫秒时的状态（时间的函数；每一步最后都停在一个完整的终态上） */
function storyAt(step: number, ms: number, total: number): Story {
  const base: Story = { step, pick: 0, tune: { cols: 12, inPattern: 'centerOut', spin: 'flipY' }, frame: 0, phase: 'rendering' };
  if (step === 0) base.pick = Math.min(PICK_COUNT - 1, Math.floor(ms / PICK_EACH_MS));
  if (step === 1) {
    const p = easeInOutCubic(clamp01((ms - 500) / 3000));
    base.tune = { cols: Math.round(lerp(TUNE_START.cols, 24, p)), inPattern: PATTERNS[Math.min(2, Math.floor(p * 2.999))]!, spin: p < 0.75 ? 'flipY' : 'twist' };
  }
  if (step === 2) {
    base.tune = { cols: 24, inPattern: 'bottomToTop', spin: 'twist' };
    const r = easeInOutCubic(clamp01((ms - 300) / 2600));
    base.frame = Math.round(r * total);
    base.phase = ms < 2900 ? 'rendering' : ms < 3500 ? 'muxing' : 'done';
  }
  return base;
}

function sameStory(a: Story, b: Story): boolean {
  return a.step === b.step && a.pick === b.pick && a.frame === b.frame && a.phase === b.phase && a.tune.cols === b.tune.cols && a.tune.inPattern === b.tune.inPattern && a.tune.spin === b.tune.spin;
}

function useWide(): boolean {
  const query = '(min-width: 1024px)';
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

/**
 * 分镜的自动播放：进了视口（active）就从当前这一步的开头按时间播，播完自动进下一步，三步之后从头再来；
 * select(i) 手动切到某一步（同样从开头播）。离开视口暂停；回来从这一步的开头重新播。
 * 进度条（当前这一步走了多少）每帧直接写到 barRef 的 transform 上。
 */
function useStoryPlayer(active: boolean, total: number, barRef: RefObject<HTMLElement | null>) {
  const [story, setStory] = useState<Story>(() => storyAt(0, 0, total));
  const stepRef = useRef(0);
  const t0 = useRef(0);
  const last = useRef(story);
  const publish = useCallback(
    (now: number) => {
      const ms = now - t0.current;
      const next = storyAt(stepRef.current, ms, total);
      if (!sameStory(next, last.current)) {
        last.current = next;
        setStory(next);
      }
      const bar = barRef.current;
      if (bar) bar.style.transform = `scaleX(${clamp01(ms / STEP_MS[stepRef.current]!).toFixed(4)})`;
    },
    [total, barRef],
  );
  useEffect(() => {
    if (!active) return;
    t0.current = performance.now();
    return onFrame((s) => {
      if (s.now - t0.current >= STEP_MS[stepRef.current]!) {
        stepRef.current = (stepRef.current + 1) % STEPS.length;
        t0.current = s.now;
      }
      publish(s.now);
    });
  }, [active, publish]);
  const select = useCallback(
    (i: number) => {
      stepRef.current = i;
      t0.current = performance.now();
      publish(t0.current);
    },
    [publish],
  );
  return { story, select };
}

/** 首屏的文字 */
function HeroCopy({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const name = t('brand.name');
  return (
    <div className="intro relative">
      <p className="t-mono intro-fade flex items-center gap-2.5 text-fg-muted" style={{ '--i': 0 } as CSSProperties}>
        <span className="inline-block h-px w-8 bg-primary" aria-hidden="true" />
        {t('site.hero.eyebrow')}
      </p>
      <h1 className="t-display mt-6 sm:mt-8">
        <span className="line-mask">
          <span style={{ '--i': 0 } as CSSProperties}>{t('site.hero.titleA')}</span>
        </span>
        <span className="line-mask">
          <span style={{ '--i': 1 } as CSSProperties}>
            {t('site.hero.titleB')}
            <span className="accent inline-block whitespace-nowrap">{t('site.hero.titleC')}</span>
          </span>
        </span>
      </h1>
      <p className={`t-lead intro-fade mt-7 max-w-[34em] ${compact ? '' : 'lg:max-w-[min(36vw,30em)]'}`} style={{ '--i': 1 } as CSSProperties}>
        {t('site.hero.lead', { name })}
      </p>
      <div className="intro-fade mt-9 flex flex-wrap items-center gap-3" style={{ '--i': 2 } as CSSProperties}>
        <a href={REPO_URL} target="_blank" rel="noreferrer noopener" className={buttonVariants({ size: 'lg' })} data-testid="cta-github">
          <GithubLogo size={16} weight="fill" />
          {t('site.hero.primary')}
        </a>
        <a href={`#${SECTION.try}`} className={buttonVariants({ variant: 'secondary', size: 'lg' })} data-testid="cta-try">
          {t('site.hero.secondary')}
          <ArrowDown size={14} />
        </a>
      </div>
      <ul className={`intro-fade mt-8 flex flex-wrap gap-x-5 gap-y-2 ${compact ? '' : 'lg:max-w-[36vw]'}`} style={{ '--i': 3 } as CSSProperties} aria-label={t('site.hero.factsLabel')}>
        {(t('site.hero.facts', { returnObjects: true }) as string[]).map((f) => (
          <li key={f} className="t-mono flex items-center gap-2 text-[11px] text-fg-subtle">
            <span className="size-1 rounded-full bg-fg-faint" aria-hidden="true" />
            {f}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 一步的文字：（可选的）描边大编号、等宽标注、标题、正文，以及这一步自己的面板或读数 */
function StepCopy({ step, index, story, numeral = true, panel }: { step: Step; index: number; story: Story; numeral?: boolean; panel?: ReactNode }) {
  const { t } = useTranslation();
  const { language } = usePrefs();
  const entries = useMemo(() => showcaseEntries().slice(0, PICK_COUNT), []);
  const active = story.step === index;
  return (
    <div className="relative" data-step={step} data-active={active}>
      {numeral && (
        <span className="t-tab t-outline block text-[clamp(72px,8.4vw,136px)] leading-[.8] font-medium tracking-[-0.06em] select-none" aria-hidden="true">
          {String(index + 1).padStart(2, '0')}
        </span>
      )}
      <p className={`t-mono text-primary-text ${numeral ? 'mt-5' : ''}`}>{t(`site.story.steps.${step}.kicker`)}</p>
      <h3 className="t-h2 mt-3 !text-[clamp(32px,3.6vw,58px)]">{t(`site.story.steps.${step}.title`)}</h3>
      <p className="t-lead mt-4 max-w-[26em] !text-[clamp(16px,1.15vw,18px)]">{t(`site.story.steps.${step}.body`)}</p>
      {panel && <div className="relative z-10 mt-7">{panel}</div>}
      {step === 'pick' && (
        <ol className="mt-7 space-y-1.5">
          {entries.map((e, i) => (
            <li key={e.id} className={`flex items-center gap-3 text-[15px] transition-colors duration-300 ${active && story.pick === i ? 'text-foreground' : 'text-fg-subtle'}`}>
              <span className={`h-px transition-all duration-500 ease-(--ease-expo) ${active && story.pick === i ? 'w-8 bg-primary' : 'w-3 bg-fg-faint'}`} aria-hidden="true" />
              {localize(e.manifest.name, language)}
            </li>
          ))}
          <li className="t-mono pt-2 text-[10.5px] text-fg-subtle">{t('site.story.steps.pick.more')}</li>
        </ol>
      )}
    </div>
  );
}

export function Stage() {
  const { reducedMotion } = usePrefs();
  return reducedMotion ? <StaticStage /> : <ScrollStage />;
}

/** 正常（有动效）的版本 */
function ScrollStage() {
  const { t } = useTranslation();
  const wide = useWide();
  const rootRef = useRef<HTMLDivElement>(null);
  const storyRef = useRef<HTMLElement>(null);
  const monitorRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  const entries = useMemo(() => showcaseEntries(), []);
  const tuned = entries.find((e) => e.id === TUNED) ?? entries[0]!;
  const total = Math.round((defaultDuration(tuned.manifest) ?? 1.1) * 60);
  /** 剪辑点所在的帧（按 timeline 的默认时长推算，与应用导出完成页上写的是同一帧） */
  const cutFrame = Math.round((defaultCutTime(tuned.manifest) ?? 0.55) * 60);

  // 分镜进了视口才播放
  const [storyVisible, setStoryVisible] = useState(false);
  useEffect(() => {
    const el = storyRef.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => setStoryVisible(es.some((e) => e.isIntersecting)), { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const { story, select } = useStoryPlayer(storyVisible, total, barRef);

  // 面板的位姿：在首屏还是在分镜由滚动位置决定（只有两个终态），位姿本身用弹簧自己走过去；不在视口里时直接落到终态
  useEffect(() => {
    const root = rootRef.current;
    const storyEl = storyRef.current;
    const monitor = monitorRef.current;
    if (!root || !storyEl) return;
    const rootT = track(root);
    const storyT = track(storyEl);
    let k = 0;
    let vk = 0;
    let rx = 0;
    let ry = 0;
    let vrx = 0;
    let vry = 0;
    let settled = '';
    const off = onFrame((s) => {
      const g = rootT.geometry;
      const visible = s.y < g.top + g.height && s.y + s.vh > g.top;
      const target = storyT.geometry.top - s.y < s.vh * 0.6 ? 1 : 0;
      if (!visible) {
        k = target;
        vk = 0;
      } else [k, vk] = spring(k, vk, target, 5.5, s.dt);
      if (Math.abs(k - target) < 0.0015 && Math.abs(vk) < 0.01) {
        k = target;
        vk = 0;
      }
      const now = k === target ? 'true' : 'false';
      if (now !== settled) {
        settled = now;
        root.dataset.settled = now;
        root.dataset.pose = target === 1 ? 'story' : 'hero';
      }
      if (!visible) return;
      // 指针让面板微微转动（同样是弹簧）
      const pointer = s.pointer;
      const tx = pointer && wide ? ((pointer.y / s.vh) * 2 - 1) * (3 - k * 1.8) : 0;
      const ty = pointer && wide ? ((pointer.x / s.vw) * 2 - 1) * (4 - k * 2.6) : 0;
      [rx, vrx] = spring(rx, vrx, -tx, 9, s.dt);
      [ry, vry] = spring(ry, vry, ty, 9, s.dt);
      const inv = 1 - k;
      if (wide && monitor) {
        monitor.style.transform = `translate3d(${(inv * s.vw * 0.04).toFixed(1)}px, ${(inv * s.vh * 0.36).toFixed(1)}px, 0) rotateX(${(inv * 22 + rx).toFixed(2)}deg) rotateY(${(inv * -18 + ry).toFixed(2)}deg) rotateZ(${(inv * 3).toFixed(2)}deg) scale(${(0.86 + k * 0.14).toFixed(4)})`;
      }
    });
    return () => {
      off();
      rootT.untrack();
      storyT.untrack();
    };
  }, [wide]);

  const pickIds = useMemo(() => entries.slice(0, PICK_COUNT).map((e) => e.id), [entries]);
  // 首屏时面板自己轮换模板；进了分镜由分镜驱动
  const driving = storyVisible;
  const control: LiveViewerControl = useMemo(() => {
    if (!driving) return {};
    if (story.step === 0) return { templateId: pickIds[story.pick] ?? null };
    const params: ParamValues = { cols: story.tune.cols, inPattern: story.tune.inPattern, spin: story.tune.spin };
    // 导出时预览的播放头停在正在渲染的那一帧；渲染完（封装、完成）停在剪辑点，和应用的完成页一样指出剪辑点那一帧
    const scrub = story.step !== 2 || total <= 0 ? null : story.phase === 'rendering' ? story.frame / total : cutFrame / total;
    return { templateId: TUNED, params, scrub };
  }, [driving, story, pickIds, total, cutFrame]);

  const viewer = <LiveViewer autoCycle testId="hero-viewer" control={control} noteHiddenOnNarrow={!wide} className={wide ? undefined : '!bg-[var(--surface-1)]'} />;

  return (
    <div ref={rootRef} className="relative" data-motion="stage" data-settled="true" data-pose="hero">
      {/* sticky 的背景：预览面板（宽屏）。只是背景，文字照常滚过去；后面的方块是全页共用的 3D 世界（motion/world） */}
      <div className="pointer-events-none sticky top-0 z-0 h-[100svh] overflow-hidden" style={{ perspective: '1600px' }}>
        <div className="absolute inset-0 bg-dots fade-mask opacity-60" aria-hidden="true" />
        {wide && (
          <div className="pointer-events-auto absolute top-[calc(50%+var(--nav-h)/2)] right-[var(--gutter)] w-[min(56vw,960px)] -translate-y-1/2" style={{ transformStyle: 'preserve-3d' }}>
            <div ref={monitorRef} className="relative will-change-transform" style={{ transformStyle: 'preserve-3d', transformOrigin: '60% 50%' }}>
              <span data-allay-anchor="hero" data-allay-yield data-allay-until={SECTION.workflow} className="absolute top-[-9%] left-[-4%] size-1" aria-hidden="true" />
              {viewer}
            </div>
          </div>
        )}
      </div>

      {/* 正常滚动的文字（盖在背景上；只有文字和控件接收指针，面板照常可点） */}
      <div className="pointer-events-none relative z-10 -mt-[100svh]">
        <section id={SECTION.top} data-tl-clip="intro" data-tl-color="var(--allay)" className="relative flex min-h-[100svh] flex-col">
          <div className={`wrap pointer-events-auto flex-1 pt-[calc(var(--nav-h)+7vh)] ${wide ? 'pb-[14vh]' : 'pb-12'}`}>
            <div className={wide ? 'max-w-[60vw]' : ''}>
              <HeroCopy />
            </div>
          </div>
          {/* 给体素悦灵留的空白（motion/world 把它拼在这个框里）：宽屏在右上、预览面板的上方，窄屏在文字下面 */}
          <div
            data-voxel-slot="allay"
            aria-hidden="true"
            className={wide ? 'pointer-events-none absolute top-[calc(var(--nav-h)+3vh)] right-[var(--gutter)] h-[44vh] w-[32vw]' : 'pointer-events-none mx-auto -mt-6 mb-4 h-[24svh] min-h-[170px] w-[min(100%-2*var(--gutter),420px)]'}
          />
          <div className="wrap pointer-events-none hidden pb-8 lg:block">
            <p className="t-mono flex items-center gap-3 text-[10.5px] text-fg-subtle">
              <span className="relative h-8 w-px overflow-hidden bg-[var(--site-line-hi)]" aria-hidden="true">
                <span className="absolute inset-x-0 top-0 h-3 animate-[scroll-cue_1.8s_var(--ease-in-out)_infinite] bg-primary" />
              </span>
              {t('site.hero.scrollCue')}
            </p>
          </div>
        </section>

        <section ref={storyRef} id={SECTION.workflow} data-tl-clip="workflow" data-tl-color="var(--stage-enter)" aria-labelledby="story-title" className={`relative ${wide ? 'min-h-[100svh] pb-[10vh]' : 'pb-16'}`}>
          {!wide && <div className="pointer-events-auto px-[var(--gutter)] pt-6">{viewer}</div>}
          <div className={`wrap pointer-events-auto relative ${wide ? 'pt-[calc(var(--nav-h)+6vh)]' : 'pt-12'}`}>
            <div className={wide ? 'max-w-[min(34vw,520px)]' : ''}>
              <p className="t-mono text-fg-subtle">{t('site.story.kicker')}</p>
              <h2 id="story-title" className="t-h2 mt-4 !text-[clamp(34px,3.8vw,64px)]">
                {t('site.story.title')}
              </h2>
              <p className="t-lead mt-5 !text-[clamp(16px,1.15vw,18px)]">{t('site.story.lead')}</p>

              {/* 三步：标签页（应用的 Tabs，可点击、可用方向键切换），下面一条细线是这一步自动播放的进度 */}
              <Tabs value={story.step} onValueChange={(v) => select(Number(v))} className="relative mt-9">
                <TabsList aria-label={t('site.story.stepsLabel')} className="gap-1">
                  {STEPS.map((s, i) => (
                    <TabsTrigger key={s} value={i} data-testid="story-tab">
                      <span className="num text-fg-subtle">{String(i + 1).padStart(2, '0')}</span>
                      {t(`site.story.steps.${s}.tab`)}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {wide && <span data-allay-anchor="story" data-allay-facing="left" className="absolute top-1/2 right-0 size-1" aria-hidden="true" />}
              </Tabs>
              <div className="mt-3 h-px w-full bg-[var(--site-line)]" aria-hidden="true">
                <span ref={barRef} className="block h-px origin-left bg-primary" style={{ transform: 'scaleX(0)' }} />
              </div>

              {/* 三步叠在同一格里（高度取最高的那一步，切换时版面不跳），只显示当前这一步 */}
              <div className="story-steps mt-8 grid" aria-live="polite">
                {STEPS.map((s, i) => (
                  <div key={s} className="[grid-area:1/1]" data-active={story.step === i}>
                    <StepCopy
                      step={s}
                      index={i}
                      story={story}
                      numeral={false}
                      panel={
                        s === 'tune' ? (
                          <TunePanel manifest={tuned.manifest} values={story.step === 1 ? story.tune : TUNE_START} className="max-w-full" />
                        ) : s === 'export' ? (
                          <ExportPanel frame={story.step === 2 ? story.frame : 0} total={total} phase={story.step === 2 ? story.phase : 'rendering'} live={story.step === 2 && storyVisible} cutFrame={cutFrame} className="max-w-full" />
                        ) : undefined
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/** 减少动效：没有 sticky 的编排，所有内容按顺序排好、一开始就是终态 */
function StaticStage() {
  const { t } = useTranslation();
  const entries = useMemo(() => showcaseEntries(), []);
  const tuned = entries.find((e) => e.id === TUNED) ?? entries[0]!;
  const total = Math.round((defaultDuration(tuned.manifest) ?? 1.1) * 60);
  const cutFrame = Math.round((defaultCutTime(tuned.manifest) ?? 0.55) * 60);
  // 三步都是终态（导出完成）
  const story = storyAt(2, Number.MAX_SAFE_INTEGER, total);
  return (
    <>
      <section id={SECTION.top} data-tl-clip="intro" data-tl-color="var(--allay)" className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <div className="absolute inset-0 bg-dots fade-mask opacity-70" />
        </div>
        <div className="wrap relative pt-[calc(var(--nav-h)+8vh)] pb-16">
          <div data-voxel-slot="allay" aria-hidden="true" className="pointer-events-none absolute top-[46vh] right-[var(--gutter)] hidden h-[28vh] w-[30vw] lg:block" />
          <HeroCopy compact />
          <div className="relative mt-14 max-w-[960px]">
            <span data-allay-anchor="hero" data-allay-yield className="absolute top-[-8%] left-[-3%] size-1" aria-hidden="true" />
            <LiveViewer autoCycle testId="hero-viewer" />
          </div>
        </div>
      </section>
      <section id={SECTION.workflow} data-tl-clip="workflow" data-tl-color="var(--stage-enter)" aria-labelledby="story-title" className="relative">
        <div className="wrap py-24">
          <p className="t-mono text-fg-subtle">{t('site.story.kicker')}</p>
          <h2 id="story-title" className="t-h2 mt-4 max-w-[12em]">
            {t('site.story.title')}
          </h2>
          <p className="t-lead mt-5 max-w-[30em]">{t('site.story.lead')}</p>
          <div className="mt-16 grid gap-16 lg:grid-cols-3 lg:gap-10">
            {STEPS.map((s, i) => (
              <div key={s}>
                <StepCopy
                  step={s}
                  index={i}
                  story={{ ...story, step: i }}
                  panel={
                    s === 'tune' ? (
                      <TunePanel manifest={tuned.manifest} values={story.tune} className="max-w-full" />
                    ) : s === 'export' ? (
                      <ExportPanel frame={total} total={total} phase="done" live cutFrame={cutFrame} className="max-w-full" />
                    ) : undefined
                  }
                />
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
