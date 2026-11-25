import { ICON_DEFAULTS } from '@allay/ui/lib/icons';
import { IconContext } from '@phosphor-icons/react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { CutScene } from './components/CutScene';
import { FeaturesSection } from './components/FeaturesSection';
import { Footer } from './components/Footer';
import { Nav } from './components/Nav';
import { OpenSourceSection } from './components/OpenSourceSection';
import { SimulatorSection } from './components/SimulatorSection';
import { TemplatesSection } from './components/TemplatesSection';
import { Stage } from './components/stage/Stage';
import { AllayGuide } from './motion/AllayGuide';
import { World } from './motion/world/World';
import { usePrefs } from './prefs';

function useDocumentMeta() {
  const { t, i18n } = useTranslation();
  const { language } = usePrefs();
  useEffect(() => {
    if (i18n.language !== language) void i18n.changeLanguage(language);
  }, [i18n, language]);
  useEffect(() => {
    const name = t('brand.name');
    document.title = t('site.meta.title', { name });
    document.querySelector('meta[name="description"]')?.setAttribute('content', t('site.meta.description'));
  }, [t, i18n.language]);
}

/** 委托更新所有 .card-spotlight 卡片的指针聚光坐标（不绑多层监听器，开启减少动态效果时跳过） */
function useSpotlightCards(disabled: boolean) {
  useEffect(() => {
    if (disabled) return;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerType === 'touch' || !(ev.target instanceof Element)) return;
      const card = ev.target.closest<HTMLElement>('.card-spotlight');
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--spot-x', `${(ev.clientX - r.left).toFixed(1)}px`);
      card.style.setProperty('--spot-y', `${(ev.clientY - r.top).toFixed(1)}px`);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [disabled]);
}

export function Site() {
  useDocumentMeta();
  const { reducedMotion } = usePrefs();
  useSpotlightCards(reducedMotion);

  return (
    <IconContext.Provider value={ICON_DEFAULTS}>
      {/* 全页共用的 3D 体素悦灵与磁吸方块世界（固定在内容后层，软件光栅化自动降档） */}
      <World />
      <Nav />
      <main className="relative z-[1] overflow-x-clip">
        <Stage />
        <CutScene />
        <SimulatorSection />
        <TemplatesSection />
        <FeaturesSection />
        <OpenSourceSection />
      </main>
      <Footer />
      <AllayGuide />
    </IconContext.Provider>
  );
}
