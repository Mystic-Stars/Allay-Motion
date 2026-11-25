// 首屏 + 分镜（三步工作流）共用的立体电影舞台：
// - 首屏：背景带指针跟随的悦灵生物发光体积光晕（.hero-aura）与 3D 透视非编网格地平线（.hero-horizon）；
//   左上为巨幅展示标题与磁吸行动按钮，右上为 11,640 体素拼成的像素级还原 3D 悦灵雕塑，
//   右下为完整显露在首屏之内的 3D 透视斜躺实时监视器（带 @property 旋转流光细边框与取景器四角准星）；
// - 走进“工作流”一节时，同一个监视器以阻尼弹簧立起并移至右栏，依次演播选模板 → 调参数 → 导出（含 AllayProgress 捧块与跳舞编排）。
import type { AllayProgressPhase } from '@allay/mascot';
import { localize, type ParamValues } from '@allay/template-sdk';
import { buttonVariants } from '@allay/ui/components/button';
import { Tabs, TabsList, TabsTrigger } from '@allay/ui/components/tabs';
import { ArrowDown, GithubLogo, Sparkle } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { defaultCutTime, defaultDuration, showcaseEntries } from '../../../host/templates';
import { REPO_URL, SECTION } from '../../links';
import { clamp01, easeInOutCubic, lerp, onFrame, spring, track } from '../../motion/frame';
import { usePrefs } from '../../prefs';
import { LiveViewer, type LiveViewerControl } from '../LiveViewer';
import { ExportPanel, TunePanel, type TuneValues } from './panels';

const TUNED = 'allay.builtin.block-wipe';
const STEPS = ['pick', 'tune', 'export'] as const;
type Step = (typeof STEPS)[number];
const PICK_COUNT = 4;
const PICK_EACH_MS = 1350;
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

function storyAt(step: number, ms: number, total: number): Story {
  const base: Story = { step, pick: 0, tune: { cols: 12, inPattern: 'centerOut', spin: 'flipY' }, frame: 0, phase: 'rendering' };
  if (step === 0) base.pick = Math.min(PICK_COUNT - 1, Math.floor(ms / PICK_EACH_MS));
  if (step === 1) {
    const p = easeInOutCubic(clamp01((ms - 500) / 3000));
    base.tune = {
      cols: Math.round(lerp(TUNE_START.cols, 24, p)),
      inPattern: PATTERNS[Math.min(2, Math.floor(p * 2.999))]!,
      spin: p < 0.75 ? 'flipY' : 'twist',
    };
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
  return (
    a.step === b.step &&
    a.pick === b.pick &&
    a.frame === b.frame &&
    a.phase === b.phase &&
    a.tune.cols === b.tune.cols &&
    a.tune.inPattern === b.tune.inPattern &&
    a.tune.spin === b.tune.spin
  );
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
  const select = useCallback(
    (i: number) => {
      stepRef.current = ((i % STEPS.length) + STEPS.length) % STEPS.length;
      t0.current = performance.now();
      publish(t0.current);
    },
    [publish],
  );
  useEffect(() => {
    if (!active) {
      if (barRef.current) barRef.current.style.transform = 'scaleX(0)';
      return;
    }
    t0.current = performance.now();
    publish(t0.current);
    return onFrame((s) => {
      if (s.now - t0.current >= STEP_MS[stepRef.current]!) {
        stepRef.current = (stepRef.current + 1) % STEPS.length;
        t0.current = s.now;
      }
      publish(s.now);
    });
  }, [active, publish, barRef]);
  return { story, select };
}

/** 微磁吸主操作按钮：指针靠近时轻微跟手，离开时弹性复位 */
function MagneticAnchor({ href, testId, children }: { href: string; testId?: string; children: ReactNode }) {
  const { reducedMotion } = usePrefs();
  const ref = useRef<HTMLAnchorElement>(null);

  const onMove = (e: PointerEvent<HTMLAnchorElement>) => {
    if (reducedMotion || e.pointerType === 'touch') return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = ((e.clientX - (r.left + r.width / 2)) / (r.width / 2)) * 5.5;
    const dy = ((e.clientY - (r.top + r.height / 2)) / (r.height / 2)) * 4;
    el.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0)`;
  };

  const onLeave = () => {
    if (ref.current) ref.current.style.transform = '';
  };

  return (
    <a
      ref={ref}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      className={`${buttonVariants({ size: 'lg' })} transition-transform duration-200 ease-out`}
      data-testid={testId}
    >
      {children}
    </a>
  );
}

function HeroCopy({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const name = t('brand.name');
  return (
    <div className="intro">
      <div className="intro-fade flex flex-wrap items-center gap-3" style={{ '--i': 0 } as CSSProperties}>
        <span className="inline-flex items-center gap-2 rounded-full border border-[var(--site-line-hi)] bg-site-card/85 px-3 py-1 text-[11px]">
          <span className="relative flex size-2" aria-hidden="true">
            <span className="absolute inset-0 animate-ping rounded-full bg-danger opacity-70" />
            <span className="relative size-2 rounded-full bg-danger" />
          </span>
          <span className="t-mono text-[10.5px] text-foreground">REC · 60 FPS · ALPHA</span>
        </span>
        <span className="t-mono text-fg-subtle">{t('site.hero.eyebrow')}</span>
      </div>

      <h1 className="t-display mt-6">
        <span className="line-mask">
          <span style={{ '--i': 0 } as CSSProperties}>{t('site.hero.line1')}</span>
        </span>
        <span className="line-mask">
          <span style={{ '--i': 1 } as CSSProperties}>
            {t('site.hero.line2')}
            <span className="accent">{t('site.hero.line3')}</span>
          </span>
        </span>
      </h1>

      <p className={`t-lead intro-fade mt-6 max-w-[33em] ${compact ? '' : 'lg:max-w-[min(36vw,29em)]'}`} style={{ '--i': 1 } as CSSProperties}>
        {t('site.hero.lead', { name })}
      </p>

      <div className="intro-fade mt-8 flex flex-wrap items-center gap-3" style={{ '--i': 2 } as CSSProperties}>
        <MagneticAnchor href={REPO_URL} testId="cta-github">
          <GithubLogo size={16} weight="fill" />
          {t('site.hero.primary')}
        </MagneticAnchor>
        <a href={`#${SECTION.try}`} className={buttonVariants({ variant: 'secondary', size: 'lg' })} data-testid="cta-try">
          {t('site.hero.secondary')}
          <ArrowDown size={14} />
        </a>
      </div>

      <ul className={`intro-fade mt-7 flex flex-wrap gap-x-5 gap-y-2 ${compact ? '' : 'lg:max-w-[38vw]'}`} style={{ '--i': 3 } as CSSProperties} aria-label={t('site.hero.factsLabel')}>
        {(t('site.hero.facts', { returnObjects: true }) as string[]).map((f) => (
          <li key={f} className="t-mono flex items-center gap-2 text-[11px] text-fg-subtle">
            <span className="size-1 rounded-full bg-primary" aria-hidden="true" />
            {f}
          </li>
        ))}
      </ul>

      {!compact && (
        <p className="intro-fade mt-5 hidden items-center gap-2 rounded-lg border border-[var(--site-line)] bg-site-card/65 px-3 py-1.5 text-[12px] text-fg-muted lg:inline-flex" style={{ '--i': 4 } as CSSProperties}>
          <Sparkle size={13} weight="fill" className="shrink-0 text-primary-text" aria-hidden="true" />
          <span>{t('site.hero.worldHint', { mascot: t('brand.mascot') })}</span>
        </p>
      )}
    </div>
  );
}

function StepCopy({ step, index, story, numeral = true, panel }: { step: Step; index: number; story: Story; numeral?: boolean; panel?: ReactNode }) {
  const { t } = useTranslation();
  const { language } = usePrefs();
  const entries = useMemo(() => showcaseEntries().slice(0, PICK_COUNT), []);
  const active = story.step === index;
  return (
    <div className="relative" data-step={step} data-active={active}>
      {numeral && (
        <span className="t-tab t-outline block text-[clamp(68px,8vw,128px)] leading-[.8] font-medium tracking-[-0.06em] select-none" aria-hidden="true">
          {String(index + 1).padStart(2, '0')}
        </span>
      )}
      <p className={`t-mono text-primary-text ${numeral ? 'mt-5' : ''}`}>{t(`site.story.steps.${step}.kicker`)}</p>
      <h3 className="t-h2 mt-3 !text-[clamp(30px,3.4vw,56px)]">{t(`site.story.steps.${step}.title`)}</h3>
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

export function Stage({ requestPick }: { requestPick?: { id: string; seq: number } | null }) {
  const { reducedMotion } = usePrefs();
  return reducedMotion ? <StaticStage requestPick={requestPick} /> : <ScrollStage requestPick={requestPick} />;
}

function ScrollStage({ requestPick }: { requestPick?: { id: string; seq: number } | null }) {
  const { t } = useTranslation();
  const wide = useWide();
  const rootRef = useRef<HTMLDivElement>(null);
  const auraRef = useRef<HTMLDivElement>(null);
  const storyRef = useRef<HTMLElement>(null);
  const monitorRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  const entries = useMemo(() => showcaseEntries(), []);
  const tuned = entries.find((e) => e.id === TUNED) ?? entries[0]!;
  const total = Math.round((defaultDuration(tuned.manifest) ?? 1.1) * 60);
  const cutFrame = Math.round((defaultCutTime(tuned.manifest) ?? 0.55) * 60);

  const [storyVisible, setStoryVisible] = useState(false);
  const [manualPick, setManualPick] = useState(false);
  useEffect(() => {
    const el = storyRef.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => setStoryVisible(es.some((e) => e.isIntersecting)), { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const { story, select } = useStoryPlayer(storyVisible && !manualPick, total, barRef);

  useEffect(() => {
    const root = rootRef.current;
    const storyEl = storyRef.current;
    const monitor = monitorRef.current;
    const aura = auraRef.current;
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
      } else {
        [k, vk] = spring(k, vk, target, 5.5, s.dt);
      }
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
      const pointer = s.pointer;
      if (pointer && aura) {
        aura.style.setProperty('--hero-x', `${((pointer.x / s.vw) * 100).toFixed(1)}%`);
        aura.style.setProperty('--hero-y', `${((pointer.y / s.vh) * 100).toFixed(1)}%`);
      }
      const tx = pointer && wide ? ((pointer.y / s.vh) * 2 - 1) * (3.2 - k * 1.8) : 0;
      const ty = pointer && wide ? ((pointer.x / s.vw) * 2 - 1) * (4.4 - k * 2.8) : 0;
      [rx, vrx] = spring(rx, vrx, -tx, 9, s.dt);
      [ry, vry] = spring(ry, vry, ty, 9, s.dt);
      const inv = 1 - k;
      if (wide && monitor) {
        // 首屏完整显露在折线之上（右上体素悦灵 + 右下完整 3D 斜躺监视器同屏辉映），滚入分镜时弹簧立正
        monitor.style.transform = k === 1 ? 'none' : `translate3d(${(inv * s.vw * 0.018).toFixed(1)}px, ${(inv * s.vh * 0.115).toFixed(1)}px, 0) rotateX(${(inv * (13.5 + rx)).toFixed(2)}deg) rotateY(${(inv * (-15.5 + ry)).toFixed(2)}deg) rotateZ(${(inv * 2).toFixed(2)}deg) scale(${(0.81 + k * 0.19).toFixed(4)})`;
      }
    });
    return () => {
      off();
      rootT.untrack();
      storyT.untrack();
    };
  }, [wide]);

  const pickIds = useMemo(() => entries.slice(0, PICK_COUNT).map((e) => e.id), [entries]);
  const driving = storyVisible && !manualPick;
  const control: LiveViewerControl = useMemo(() => {
    if (!driving) return {};
    if (story.step === 0) return { templateId: pickIds[story.pick] ?? null };
    const params: ParamValues = { cols: story.tune.cols, inPattern: story.tune.inPattern, spin: story.tune.spin };
    const scrub = story.step !== 2 || total <= 0 ? null : story.phase === 'rendering' ? story.frame / total : cutFrame / total;
    return { templateId: TUNED, params, scrub };
  }, [driving, story, pickIds, total, cutFrame]);

  const viewer = (
    <div className="studio-bezel">
      <span className="viewfinder-corners" aria-hidden="true" />
      <LiveViewer
        autoCycle
        initialId="allay.builtin.portal-gate"
        testId="hero-viewer"
        requestPick={requestPick}
        control={control}
        onPick={() => setManualPick(true)}
        noteHiddenOnNarrow={!wide}
        className={wide ? undefined : '!bg-[var(--surface-1)]'}
      />
    </div>
  );

  return (
    <div ref={rootRef} className="relative" data-motion="stage" data-settled="true" data-pose="hero">
      <div className="pointer-events-none sticky top-0 z-0 h-[100svh] overflow-hidden" style={{ perspective: '1600px' }}>
        <div ref={auraRef} className="hero-aura absolute inset-0 transition-opacity duration-700" aria-hidden="true" />
        <div className="hero-horizon" aria-hidden="true" />
        <div className="absolute inset-0 bg-dots fade-mask opacity-55" aria-hidden="true" />
      </div>
      <div className="pointer-events-none sticky top-0 z-20 -mt-[100svh] h-[100svh] overflow-hidden" style={{ perspective: '1600px' }}>
        {wide && (
          <div className="pointer-events-auto absolute top-[calc(50%+var(--nav-h)/2)] right-[var(--gutter)] w-[min(51vw,860px)] -translate-y-1/2" style={{ transformStyle: 'preserve-3d' }}>
            <div ref={monitorRef} className="relative will-change-transform" style={{ transformStyle: 'preserve-3d', transformOrigin: '58% 50%' }}>
              <span data-allay-anchor="hero" data-allay-yield data-allay-until={SECTION.workflow} className="absolute top-[-9%] left-[-4%] size-1" aria-hidden="true" />
              {viewer}
            </div>
          </div>
        )}
      </div>

      <div className="pointer-events-none relative z-10 -mt-[100svh]">
        <section id={SECTION.top} data-tl-clip="intro" data-tl-color="var(--allay)" className="relative flex min-h-[100svh] flex-col">
          <div className={`wrap flex-1 pt-[calc(var(--nav-h)+5.5vh)] ${wide ? 'pb-[10vh]' : 'pb-12'}`}>
            <div className={wide ? 'max-w-[54vw] [&_a]:pointer-events-auto' : 'pointer-events-auto'}>
              <HeroCopy />
            </div>
          </div>
          <div
            data-voxel-slot="allay"
            aria-hidden="true"
            className={
              wide
                ? 'pointer-events-none absolute top-[calc(var(--nav-h)+0.5vh)] right-[calc(var(--gutter)+0.8vw)] h-[32vh] w-[28vw]'
                : 'pointer-events-none mx-auto -mt-6 mb-4 h-[24svh] min-h-[170px] w-[min(100%-2*var(--gutter),420px)]'
            }
          />
          <div className="wrap pointer-events-none hidden pb-6 lg:block">
            <p className="t-mono flex items-center gap-3 text-[10.5px] text-fg-subtle">
              <span className="relative h-7 w-px overflow-hidden bg-[var(--site-line-hi)]" aria-hidden="true">
                <span className="absolute inset-x-0 top-0 h-3 animate-[scroll-cue_1.8s_var(--ease-in-out)_infinite] bg-primary" />
              </span>
              {t('site.hero.scrollCue')}
            </p>
          </div>
        </section>

        <section ref={storyRef} id={SECTION.workflow} data-tl-clip="workflow" data-tl-color="var(--stage-enter)" aria-labelledby="story-title" className={`relative ${wide ? 'min-h-[100svh] pb-[10vh]' : 'pb-16'}`}>
          <span className="scene-watermark absolute top-8 left-[var(--gutter)] hidden lg:block" aria-hidden="true">
            SCENE 01
          </span>
          {!wide && <div className="pointer-events-auto px-[var(--gutter)] pt-6">{viewer}</div>}
          <div className={`wrap relative ${wide ? 'pt-[calc(var(--nav-h)+6vh)]' : 'pt-12'}`}>
            <div className={`pointer-events-auto ${wide ? 'max-w-[min(35vw,520px)]' : ''}`}>
              <p className="t-mono text-fg-subtle">{t('site.story.kicker')}</p>
              <h2 id="story-title" className="t-h2 mt-4 !text-[clamp(34px,3.8vw,64px)]">
                {t('site.story.title')}
              </h2>
              <p className="t-lead mt-5 !text-[clamp(16px,1.15vw,18px)]">{t(`site.story.lead`)}</p>

              <Tabs
                value={story.step}
                onValueChange={(v) => {
                  setManualPick(false);
                  select(Number(v));
                }}
                className="relative mt-9"
              >
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
                          <TunePanel manifest={tuned.manifest} values={story.tune} className="max-w-full" />
                        ) : s === 'export' ? (
                          <ExportPanel frame={story.frame} total={total} phase={story.phase} live={storyVisible && story.step === 2} cutFrame={cutFrame} className="max-w-full" />
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

function StaticStage({ requestPick }: { requestPick?: { id: string; seq: number } | null }) {
  const { t } = useTranslation();
  const entries = useMemo(() => showcaseEntries(), []);
  const tuned = entries.find((e) => e.id === TUNED) ?? entries[0]!;
  const total = Math.round((defaultDuration(tuned.manifest) ?? 1.1) * 60);
  const cutFrame = Math.round((defaultCutTime(tuned.manifest) ?? 0.55) * 60);
  const story: Story = { step: 0, pick: 0, tune: { cols: 14, inPattern: 'diagonal', spin: 'flipY' }, frame: total, phase: 'done' };
  return (
    <>
      <section id={SECTION.top} data-tl-clip="intro" data-tl-color="var(--allay)" className="hero-aura relative py-20 lg:py-28">
        <div className="wrap relative">
          <div data-voxel-slot="allay" aria-hidden="true" className="pointer-events-none absolute top-[6vh] right-[var(--gutter)] hidden h-[28vh] w-[30vw] lg:block" />
          <HeroCopy compact />
          <div className="studio-bezel relative mt-14 max-w-[960px]">
            <span data-allay-anchor="hero" data-allay-yield className="absolute top-[-8%] left-[-3%] size-1" aria-hidden="true" />
            <LiveViewer autoCycle initialId="allay.builtin.portal-gate" testId="hero-viewer" requestPick={requestPick} />
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
