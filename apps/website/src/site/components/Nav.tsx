// 剪辑轨道时间轴顶栏 + 原生 View Transitions API 圆形光圈主题切换。
import { AllayHead } from '@allay/mascot';
import { Button, buttonVariants } from '@allay/ui/components/button';
import { GithubLogo, Moon, Sun } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { REPO_URL } from '../links';
import { clamp01, maxScroll, onFrame, onGeometryChange, spring, track, type Geometry } from '../motion/frame';
import { setLanguage, setTheme, usePrefs } from '../prefs';

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

function useClips(): { clips: Clip[]; cut: Geometry | null } {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<{ clips: Clip[]; cut: Geometry | null }>({ clips: [], cut: null });
  useEffect(() => {
    const els = [...document.querySelectorAll<HTMLElement>('[data-tl-clip]')];
    const handles = els.map((el) => track(el));
    const cutEl = document.querySelector<HTMLElement>('[data-cut]');
    const cutHandle = cutEl ? track(cutEl) : null;
    setState({
      clips: els.map((el, i) => ({
        id: el.id,
        label: t(`site.nav.${el.dataset.tlClip}`),
        color: el.dataset.tlColor ?? 'var(--stage-hold)',
        geometry: handles[i]!.geometry,
      })),
      cut: cutHandle?.geometry ?? null,
    });
    return () => {
      handles.forEach((h) => h.untrack());
      cutHandle?.untrack();
    };
  }, [t, i18n.language]);
  return state;
}

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

  useEffect(() => {
    if (clips.length === 0) return;
    let lastTc = '';
    let lastCurrent = -1;
    let shown = window.scrollY;
    let vel = 0;
    let settled = '';
    const header = trackRef.current?.closest<HTMLElement>('header') ?? null;
    let trackW = trackRef.current?.clientWidth ?? 0;
    const ro = new ResizeObserver(() => {
      trackW = trackRef.current?.clientWidth ?? 0;
    });
    if (trackRef.current) ro.observe(trackRef.current);
    const links = () => [...(trackRef.current?.querySelectorAll<HTMLAnchorElement>('a[data-clip-link]') ?? [])];
    const off = onFrame((s) => {
      const max = maxScroll();
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

  const onToggleTheme = (ev: MouseEvent<HTMLButtonElement>) => {
    const next = prefs.theme === 'dark' ? 'light' : 'dark';
    const doc = document as Document & { startViewTransition?: (cb: () => void) => void };
    if (!prefs.reducedMotion && typeof doc.startViewTransition === 'function') {
      const r = ev.currentTarget.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
      document.documentElement.style.setProperty('--vt-x', `${x.toFixed(1)}px`);
      document.documentElement.style.setProperty('--vt-y', `${y.toFixed(1)}px`);
      document.documentElement.style.setProperty('--vt-r', `${Math.ceil(radius)}px`);
      doc.startViewTransition(() => setTheme(next));
      return;
    }
    setTheme(next);
  };

  return (
    <header className="nav-bar sticky top-0 z-50 h-[var(--nav-h)]" data-testid="site-nav" data-motion="nav" data-settled="true">
      <div className="wrap flex h-full items-center gap-3 sm:gap-5">
        <a href="#top" className="link-focus flex shrink-0 items-center gap-2.5 rounded-md py-1 pr-2" aria-label={t('site.nav.top')}>
          <AllayHead size={24} />
          <span className="text-[14px] font-semibold tracking-[-0.02em]">{t('brand.wordmark')}</span>
        </a>

        <nav aria-label={t('site.nav.timeline')} className="relative hidden h-full min-w-0 flex-1 items-center lg:flex">
          <div ref={trackRef} className="relative flex h-full w-full items-stretch">
            {clips.map((c, i) => (
              <a
                key={c.id}
                href={`#${c.id}`}
                data-clip-link
                data-current={i === 0 ? 'true' : 'false'}
                className="nav-clip link-focus rounded-sm text-[12px]"
                style={{ flexGrow: shares.grow[i] ?? 1, flexBasis: 0, '--clip': c.color } as CSSProperties}
              >
                <span className="truncate">{c.label}</span>
                <span className="nav-clip-bar" aria-hidden="true" />
              </a>
            ))}
            {shares.cutAt !== null && <span className="cut-mark pointer-events-none bottom-[5px]" style={{ left: `${shares.cutAt * 100}%` }} title={t('site.nav.cutMark')} aria-hidden="true" />}
            <div ref={headRef} className="playhead-line pointer-events-none" aria-hidden="true" />
          </div>
        </nav>

        <div className="relative h-[3px] min-w-6 flex-1 overflow-hidden rounded-full bg-control lg:hidden" aria-hidden="true">
          <div ref={miniHeadRef} className="h-full w-full origin-left bg-primary" style={{ transform: 'scaleX(0)' }} />
        </div>

        <span ref={tcRef} className="t-mono hidden shrink-0 text-[11px] text-fg-subtle sm:inline" data-testid="nav-timecode" aria-label={t('site.nav.timecode')}>
          00:00:00
        </span>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="lg"
            className="t-tab px-2 text-[12px] text-fg-muted"
            aria-label={t('site.nav.language')}
            data-testid="toggle-language"
            onClick={() => setLanguage(prefs.language === 'zh-CN' ? 'en' : 'zh-CN')}
          >
            {prefs.language === 'zh-CN' ? 'EN' : '中'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 text-fg-muted"
            aria-label={prefs.theme === 'dark' ? t('site.nav.light') : t('site.nav.dark')}
            data-testid="toggle-theme"
            onClick={onToggleTheme}
          >
            {prefs.theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </Button>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
            className={buttonVariants({ variant: 'secondary', size: 'lg', className: 'ml-0.5 px-2.5 sm:px-3' })}
            aria-label="GitHub"
          >
            <GithubLogo size={15} weight="fill" />
            <span className="hidden sm:inline">GitHub</span>
          </a>
        </div>
      </div>
    </header>
  );
}
