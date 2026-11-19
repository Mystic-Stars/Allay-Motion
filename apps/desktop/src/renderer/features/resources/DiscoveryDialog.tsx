import { Allay } from '@allay/mascot';
import { Button } from '@allay/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@allay/ui/components/dialog';
import { ResourceThumb } from '@allay/ui/editor';
import { useTranslation } from 'react-i18next';
import { useResourceStore } from '../../stores/resourceStore';
import { selectInstalledVersion, setVanilla } from './actions';

// 首次发现本机游戏时询问一次（03-assets.md 3.4、06-ui-design.md 6.6）。插图：悦灵 hover，手里捧着草方块（7.5 第 8 项）。
// 第二个按钮原文是“先用内置素材”；v1 没有内置素材，改为“暂不使用”（decisions.md M2b）。

export function DiscoveryDialog() {
  const { t } = useTranslation();
  const local = useResourceStore((s) => s.state?.vanilla.local ?? null);

  const answer = (consent: boolean) => {
    useResourceStore.getState().setDiscoveryHandled();
    if (consent) void selectInstalledVersion();
    else void setVanilla({ consent: false });
  };
  if (!local) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && answer(false)}>
      <DialogContent showClose={false} className="w-[460px]" data-testid="vanilla-discovery">
        <div className="flex justify-center">
          <Allay clip="hover" size={72} priority="dialog" carry={<ResourceThumb kind="block" id="minecraft:grass_block" size={20} />} />
        </div>
        <DialogTitle>{t('resources.discovery.title')}</DialogTitle>
        <DialogDescription className="text-foreground">{t('resources.discovery.body', { version: local.versionId })}</DialogDescription>
        <p className="text-sm text-fg-muted">{t('resources.discovery.local', { name: t('brand.name') })}</p>
        <DialogFooter>
          <Button variant="secondary" size="lg" data-testid="discovery-decline" onClick={() => answer(false)}>
            {t('resources.discovery.decline')}
          </Button>
          <Button autoFocus size="lg" data-testid="discovery-accept" onClick={() => answer(true)}>
            {t('resources.discovery.accept')}
          </Button>
        </DialogFooter>
        <p className="text-xs text-fg-muted">{t('resources.discovery.later')}</p>
      </DialogContent>
    </Dialog>
  );
}

/** 还没问过、探测到了本机游戏、这次启动还没处理过 */
export function useShowDiscovery(): boolean {
  return useResourceStore((s) => {
    const st = s.state;
    return !!st && !st.detecting && st.vanilla.consent === null && st.vanilla.local !== null && !s.discoveryHandled;
  });
}
