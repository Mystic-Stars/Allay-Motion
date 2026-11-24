// 页尾：片子的最后一帧。非官方声明（docs/09-compliance.md 9.5，逐字取自 brand.disclaimer）放在醒目的卡片里；
// 下面是铺满宽度的超大字标，悦灵到这里跳一段舞（活干完了、送到了）；最后一行是许可、字体署名和这一页的“出点”时间码。
import { AllayHead } from '@allay/mascot';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { LICENSE_NAME, REPO_URL } from '../links';
import { maxScroll, onGeometryChange } from '../motion/frame';
import { timecode } from './Nav';

export function Footer() {
  const { t } = useTranslation();
  const [tcOut, setTcOut] = useState('');
  useEffect(() => {
    const update = () => setTcOut(timecode(maxScroll()));
    update();
    return onGeometryChange(update);
  }, []);
  const link = 'link-focus rounded text-fg-muted underline decoration-[var(--site-line-hi)] underline-offset-4 transition-colors hover:text-foreground hover:decoration-current';
  return (
    <footer id="end" className="relative overflow-hidden border-t border-site-line pt-24" data-testid="site-footer">
      <div className="wrap relative">
        <div className="card p-6 sm:p-9" data-testid="disclaimer-box">
          <p className="t-mono text-[10.5px] text-fg-subtle">{t('site.footer.disclaimerLabel')}</p>
          <p className="mt-4 max-w-[60em] text-[15px] leading-[1.75] font-medium whitespace-pre-line" data-testid="disclaimer">
            {t('brand.disclaimer')}
          </p>
        </div>
      </div>

      <div className="relative mt-16 select-none" aria-hidden="true">
        <div className="wrap relative">
          <span data-allay-anchor="end" data-allay-clip="dance" data-allay-facing="left" className="absolute top-[8%] right-[6%] size-1" />
          {/* 有 3D 世界时这段字由方块拼出来（这里的字变透明，仍可选中、可被读屏读到） */}
          <p className="wordmark-xl -ml-[0.04em]" data-voxel-wordmark>
            {t('brand.wordmark')}
          </p>
        </div>
      </div>

      <div className="wrap relative grid gap-6 border-t border-[var(--site-line)] py-8 text-[12.5px] leading-[1.7] text-fg-subtle md:grid-cols-[auto_1fr_auto] md:gap-10">
        <div className="flex items-center gap-2.5">
          <AllayHead size={20} />
          <span className="text-[13.5px] font-semibold text-foreground">{t('brand.wordmark')}</span>
          <span className="t-mono text-[10.5px]">· {LICENSE_NAME}</span>
        </div>
        <div className="space-y-1">
          <p>
            {t('site.footer.license')}{' '}
            <a className={link} href={REPO_URL} target="_blank" rel="noreferrer noopener">
              {t('site.footer.source')}
            </a>
          </p>
          <p>{t('site.footer.fonts')}</p>
          <p>{t('site.footer.noTracking')}</p>
        </div>
        <p className="t-mono text-[10.5px] md:text-right">
          {t('site.footer.tcOut')} {tcOut}
          <br />
          <span className="text-[18px] tracking-normal text-fg-muted normal-case">{t('site.footer.end')}</span>
        </p>
      </div>
    </footer>
  );
}
