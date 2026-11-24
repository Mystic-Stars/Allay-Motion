// 导航就是这一页的时间轴：每一节是轨道上的一段片段（宽度按这一节在页面里的长度），滚动位置是播放头，
// 右边是这一页的时间码；剪辑点（页面中段唯一的转场）用应用时间轴上同样的琥珀色菱形标出来。
// 片段是普通的锚点链接（键盘可达，当前一段带 aria-current）。窄屏只留一条细的进度轨和时间码。
// 位置只在尺寸变化时量；播放头和时间码不是直接等于滚动位置：目标值跟着滚动，显示值用临界阻尼的弹簧追上去，
// 滚轮一格的跳变被化成一段顺滑的运动，停手后很快落到目标上（data-settled）。
import { AllayHead } from '@allay/mascot';
import { Button, buttonVariants } from '@allay/ui/components/button';
import { GithubLogo, Moon, Sun } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { REPO_URL } from '../links';
import { clamp01, maxScroll, onFrame, onGeometryChange, spring, track, type Geometry } from '../motion/frame';
import { setLanguage, setTheme, usePrefs } from '../prefs';

/** 页面时间码：60 fps，每滚 6 px 走一帧 */
const PX_PER_FRAME = 6;
const FPS = 60;

export function timecode(y: number): string {
  const f = Math.max(0, Math.round(y / PX_PER_FRAME));
  const s = Math.floor(f / FPS);
  const m = Math.floor(s / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(m)}:${pad(s % 60)}:${pad(f % FPS)}`;
}

interface Clip {
  id: string;
  label: string;
  color: string;
  geometry: Geometry;
}

/** 从页面上带 data-tl-clip 的元素收集片段（文档顺序；不用 data-clip：悦灵组件自己用它标当前动作） */
function useClips(): { clips: Clip[]; cut: Geometry | null } {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<{ clips: Clip[]; cut: Geometry | null }>({ clips: [], cut: null });
  useEffect(() => {
    const els = [...document.querySelectorAll<HTMLElement>('[data-tl-clip]')];
    const handles = els.map((el) => track(el));
    const cutEl = document.querySelector<HTMLElement>('[data-cut]');
    const cutHandle = cutEl ? track(cutEl) : null;
    setState({
      clips: els.map((el, i) => ({ id: el.id, label: t(`site.nav.${el.dataset.tlClip}`), color: el.dataset.tlColor ?? 'var(--stage-hold)', geometry: handles[i]!.geometry })),
      cut: cutHandle?.geometry ?? null,
    });
    return () => {
      handles.forEach((h) => h.untrack());
      cutHandle?.untrack();
    };
  }, [t, i18n.language]);
  return state;
}

/** 片段 i 在时间轴上的起点（滚动位置）：这一节的上沿走到视口 40% 处 */
function clipStart(g: Geometry, vh: number, max: number): number {
  return Math.min(max, Math.max(0, g.top - vh * 0.4));
}

export function Nav() {
  const { t } = useTranslation();
  const prefs = usePrefs();
  const { clips, cut } = useClips();
  const trackRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const miniHeadRef = useRef<HTMLDivElement>(null);
  const tcRef = useRef<HTMLSpanElement>(null);
  const [shares, setShares] = useState<{ grow: number[]; cutAt: number | null }>({ grow: [], cutAt: null });

  // 片段宽度和剪辑点位置：尺寸变化时重算
  useEffect(() => {
    if (clips.length === 0) return;
    const compute = () => {
      const vh = window.innerHeight;
      const max = maxScroll();
      const starts = clips.map((c) => clipStart(c.geometry, vh, max));
      starts[0] = 0;
      const grow = starts.map((s, i) => Math.max(0.0001, (i + 1 < starts.length ? starts[i + 1]! : max) - s) / max);
      setShares({ grow, cutAt: cut ? clamp01(cut.top / max) : null });
    };
    compute();
    return onGeometryChange(compute);
  }, [clips, cut]);

  // 播放头、当前片段、时间码：每帧按 scrollY 写
  useEffect(() => {
    if (clips.length === 0) return;
    let lastTc = '';
    let lastCurrent = -1;
    let shown = window.scrollY;
    let vel = 0;
    let settled = '';
    const header = trackRef.current?.closest<HTMLElement>('header') ?? null;
    let trackW = trackRef.current?.clientWidth ?? 0;
    const ro = new ResizeObserver(() => (trackW = trackRef.current?.clientWidth ?? 0));
    if (trackRef.current) ro.observe(trackRef.current);
    const links = () => [...(trackRef.current?.querySelectorAll<HTMLAnchorElement>('a[data-clip-link]') ?? [])];
    const off = onFrame((s) => {
      const max = maxScroll();
      // 大步跳（拖滚动条、锚点、连按 PageDown）时弹簧照样追，只是更快；离目标很近就直接落到目标上
      [shown, vel] = spring(shown, vel, s.y, Math.abs(s.y - shown) > s.vh * 3 ? 16 : 11, s.dt);
      if (Math.abs(shown - s.y) < 0.5 && Math.abs(vel) < 5) {
        shown = s.y;
        vel = 0;
      }
      const now = shown === s.y ? 'true' : 'false';
      if (now !== settled && header) {
        settled = now;
        header.dataset.settled = now;
      }
      const p = clamp01(shown / max);
      if (headRef.current) headRef.current.style.transform = `translate3d(${(p * trackW).toFixed(1)}px, 0, 0)`;
      if (miniHeadRef.current) miniHeadRef.current.style.transform = `scaleX(${p.toFixed(4)})`;
      const tc = timecode(shown);
      if (tc !== lastTc && tcRef.current) {
        tcRef.current.textContent = tc;
        lastTc = tc;
      }
      let current = 0;
      clips.forEach((c, i) => {
        if (s.y >= (i === 0 ? 0 : clipStart(c.geometry, s.vh, max))) current = i;
      });
      if (current !== lastCurrent) {
        lastCurrent = current;
        links().forEach((a, i) => {
          a.dataset.current = String(i === current);
          if (i === current) a.setAttribute('aria-current', 'true');
          else a.removeAttribute('aria-current');
        });
      }
    });
    return () => {
      off();
      ro.disconnect();
    };
  }, [clips]);

  const nextLang = prefs.language === 'zh-CN' ? 'en' : 'zh-CN';

  return (
    <header data-testid="site-nav" data-motion="nav" data-settled="true" className="nav-bar fixed inset-x-0 top-0 z-50" style={{ height: 'var(--nav-h)' }}>
      <div className="wrap flex h-full items-center gap-4 lg:gap-6">
        <a href="#top" className="link-focus flex shrink-0 items-center gap-2.5 rounded-md" aria-label={t('site.nav.home')}>
          <AllayHead size={24} label={t('brand.name')} />
          <span className="text-[15px] font-semibold tracking-[-0.02em]">{t('brand.wordmark')}</span>
        </a>

        {/* 时间轴：片段 + 播放头 + 剪辑点 */}
        <nav aria-label={t('site.nav.label')} className="relative hidden h-full min-w-0 flex-1 lg:block">
          <div ref={trackRef} className="relative flex h-full">
            {clips.map((c, i) => (
              <a
                key={c.id}
                href={`#${c.id}`}
                data-clip-link
                data-current={i === 0 ? 'true' : 'false'}
                className="nav-clip link-focus min-w-[84px] rounded-md"
                style={{ flexGrow: shares.grow[i] ?? 1, flexBasis: 0, '--clip': c.color } as CSSProperties}
              >
                <span className="t-mono truncate text-[10px] opacity-60">{String(i + 1).padStart(2, '0')}</span>
                <span className="-mt-0.5 truncate pb-2 text-[13px] font-medium">{c.label}</span>
                <span className="nav-clip-bar" aria-hidden="true" />
              </a>
            ))}
            {shares.cutAt !== null && <span className="cut-mark" style={{ left: `${shares.cutAt * 100}%` }} title={t('site.nav.cut')} aria-hidden="true" />}
            <div ref={headRef} className="pointer-events-none absolute inset-y-0 left-0" aria-hidden="true">
              <div className="playhead-line" />
            </div>
          </div>
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1 lg:ml-0">
          <span className="num mr-2 hidden h-[30px] items-center gap-1.5 rounded-lg bg-control px-2.5 text-[12px] text-fg-muted sm:inline-flex" aria-label={t('site.nav.timecode')}>
            <span className="inline-block size-1.5 rounded-full bg-primary" aria-hidden="true" />
            <span ref={tcRef}>00:00:00</span>
          </span>
          <Button
            variant="ghost"
            size="lg"
            data-testid="toggle-language"
            aria-label={t('site.nav.switchLanguage')}
            title={t('site.nav.switchLanguage')}
            lang={nextLang}
            onClick={() => setLanguage(nextLang)}
          >
            {nextLang === 'en' ? 'EN' : '中文'}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            data-testid="toggle-theme"
            aria-label={prefs.theme === 'dark' ? t('site.nav.toLight') : t('site.nav.toDark')}
            title={prefs.theme === 'dark' ? t('site.nav.toLight') : t('site.nav.toDark')}
            onClick={() => setTheme(prefs.theme === 'dark' ? 'light' : 'dark')}
          >
            {prefs.theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </Button>
          <a href={REPO_URL} target="_blank" rel="noreferrer noopener" className={buttonVariants({ variant: 'secondary', size: 'lg', className: 'ml-1' })}>
            <GithubLogo size={15} weight="fill" />
            <span className="hidden sm:inline">{t('site.nav.github')}</span>
          </a>
        </div>
      </div>
      {/* 窄屏：一条细的进度轨 */}
      <div className="absolute inset-x-0 bottom-0 h-[2px] lg:hidden" aria-hidden="true">
        <div ref={miniHeadRef} className="h-full origin-left bg-primary" style={{ transform: 'scaleX(0)' }} />
      </div>
    </header>
  );
}
