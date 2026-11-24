// 进视口时的编排（useReveal）。指针相关的光效、磁吸按钮按 shadcn 的克制风格撤掉了（docs/decisions.md 官网 · 第三版）。
import { useEffect, useRef } from 'react';
import { getPrefs } from '../prefs';

/**
 * 进视口时的编排：给元素打 data-armed / data-shown（CSS .reveal、.reveal-lines 据此做出场）。
 * 失败即显示：挂载时已经在视口里、页面没有在逐帧渲染（后台标签页）、减少动效时，直接是终态；
 * 武装之后有保底计时器，IntersectionObserver 不回调也会在进视口后一秒内显示。
 */
export function useReveal<T extends HTMLElement>(threshold = 0.2) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const show = () => {
      el.dataset.shown = 'true';
    };
    const motionOk = document.documentElement.classList.contains('motion-ok');
    if (getPrefs().reducedMotion || !motionOk || el.getBoundingClientRect().top < window.innerHeight * 0.92) {
      show();
      return;
    }
    el.dataset.armed = 'true';
    el.dataset.shown = 'false';
    const io = new IntersectionObserver(
      (es) => {
        if (!es.some((e) => e.isIntersecting)) return;
        io.disconnect();
        show();
      },
      { threshold, rootMargin: '0px 0px -8% 0px' },
    );
    io.observe(el);
    const timer = window.setInterval(() => {
      const r = el.getBoundingClientRect();
      if (r.top < window.innerHeight && r.bottom > 0) {
        window.clearInterval(timer);
        window.setTimeout(show, 900);
      }
    }, 1000);
    return () => {
      io.disconnect();
      window.clearInterval(timer);
    };
  }, [threshold]);
  return ref;
}
