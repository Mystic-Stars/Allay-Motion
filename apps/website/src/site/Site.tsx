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
import { Stage } from './components/stage/Stage';
import { TemplatesSection } from './components/TemplatesSection';
import { AllayGuide } from './motion/AllayGuide';
import { World } from './motion/world/World';
import { usePrefs } from './prefs';

/** 标题和描述跟着语言走 */
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

/**
 * 这一页就是一段正在剪辑的片子（docs/decisions.md 官网 · 第三版）：
 * 导航是时间轴、滚动是播放头；各节是片段，只在中段的剪辑点上有一次整幅转场（应用的方块擦除模板，引擎实时渲染）；
 * 悦灵沿着播放头带路，在导出完成和片尾时按应用的编排出场。
 */
export function Site() {
  useDocumentMeta();
  return (
    <IconContext.Provider value={ICON_DEFAULTS}>
      {/* 全页共用的 3D 方块世界（固定在所有内容后面） */}
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
