import { Allay, AllayLoader } from '@allay/mascot';
import { Button } from '@allay/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@allay/ui/components/popover';
import { Skeleton, ToggleGroup, ToggleGroupItem } from '@allay/ui/components/misc';
import { Tooltip, TooltipContent, TooltipTrigger } from '@allay/ui/components/tooltip';
import { PREVIEW_INSET, PreviewViewport, type PreviewBackground } from '@allay/ui/editor';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@allay/ui/components/dropdown-menu';
import { ICON, ICON_WEIGHT } from '@allay/ui/lib/icons';
import { localize } from '@allay/template-sdk';
import { CaretDown, Checkerboard, FrameCorners, Image as ImageIcon, Sparkle, Square } from '@phosphor-icons/react';
import { cn } from '@allay/ui/lib/utils';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HexColorPicker } from 'react-colorful';
import { useTranslation } from 'react-i18next';
import { notify } from '../../stores/noticeStore';
import { usePreviewStore } from '../../stores/previewStore';
import { useProjectStore } from '../../stores/projectStore';
import { useResourceStore } from '../../stores/resourceStore';
import { useTransportStore } from '../../stores/transportStore';
import { useUiStore } from '../../stores/uiStore';
import { ResourceOnboarding, useShowOnboarding } from '../resources/ResourceOnboarding';
import { previewEngine } from './previewEngine';
import { useDebugLoading } from './debugLoading';
import { DevOverlay } from './DevOverlay';
import { describeLoadIssues, MAX_SHOWN_ISSUES } from './loadIssues';
import { copyText } from '../../app/diagnostics';

// 中间：预览面板（6.4）。左上“预览”和模板名，右上规格读数（等宽）；画布按输出比例等比缩放、居中，
// 上面让出标题行、下面让出悬浮工具条（PREVIEW_INSET）。工具条悬浮在画面下方居中：缩放、背景、参考线、高质量预览。
// 引擎装载超过 180 ms 时出现悦灵的加载编排；模板出错时显示错误卡片（一句说明、“重置参数”、“复制诊断信息”）。

/** 按输出比例在可用区域里取最大的矩形；设备像素不超过输出分辨率（2.7） */
function fit(availW: number, availH: number, outW: number, outH: number, dpr: number) {
  const scale = Math.min(availW / outW, availH / outH);
  const cssWidth = Math.max(1, Math.floor(outW * scale));
  const cssHeight = Math.max(1, Math.floor(outH * scale));
  const k = Math.min(1, (cssWidth * dpr) / outW);
  return { cssWidth, cssHeight, pixelWidth: Math.max(1, Math.round(outW * k)), pixelHeight: Math.max(1, Math.round(outH * k)) };
}

/** 悬浮在画面下方居中的预览工具条：缩放、三种背景、参考线、高质量预览 */
function Toolbar({ zoomPct }: { zoomPct: number | null }) {
  const { t } = useTranslation();
  const editor = useUiStore((s) => s.settings.editor);
  const set = useUiStore.getState().setEditor;
  const item = (on: boolean) =>
    cn('inline-flex h-7 min-w-7 items-center justify-center gap-1.5 rounded-lg px-[7px] text-fg-muted transition-colors duration-(--dur-1) hover:text-foreground', on && 'bg-control-hi text-foreground');
  return (
    <div role="toolbar" aria-label={t('preview.toolbar')} className="flex h-9 items-center gap-0.5 rounded-xl bg-surface-2 px-1 shadow-float" data-testid="preview-toolbar">
      <DropdownMenu>
        <DropdownMenuTrigger render={<button type="button" className={cn(item(false), 'num text-foreground')} aria-label={t('preview.zoom')} data-testid="preview-zoom" />}>
          {editor.zoom === '100' ? '100%' : zoomPct !== null ? `${zoomPct}%` : t('preview.zoomFit')}
          <CaretDown size={ICON.xs - 1} className="text-fg-subtle" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" className="w-44">
          <DropdownMenuRadioGroup value={editor.zoom} onValueChange={(v) => set({ zoom: v as 'fit' | '100' })}>
            <DropdownMenuRadioItem value="fit">{t('preview.zoomFit')}</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="100">{t('preview.zoom100')}</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="mx-1 h-4 w-px bg-control-hi" aria-hidden="true" />
      <ToggleGroup
        value={[editor.background]}
        onValueChange={(v) => {
          const next = v[0] as PreviewBackground | undefined;
          if (next && next !== 'sample') set({ background: next });
        }}
        aria-label={t('preview.background')}
        className="h-auto gap-0.5 bg-transparent p-0"
      >
        <ToggleGroupItem value="checker" aria-label={t('preview.backgrounds.checker')} title={t('preview.backgrounds.checker')} data-testid="bg-checker" className={item(editor.background === 'checker')}>
          <Checkerboard size={ICON.md} weight={editor.background === 'checker' ? ICON_WEIGHT.active : ICON_WEIGHT.normal} />
        </ToggleGroupItem>
        <ToggleGroupItem value="solid" aria-label={t('preview.backgrounds.solid')} title={t('preview.backgrounds.solid')} data-testid="bg-solid" className={item(editor.background === 'solid')}>
          <Square size={ICON.md} weight={editor.background === 'solid' ? ICON_WEIGHT.active : ICON_WEIGHT.normal} />
        </ToggleGroupItem>
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            {/* 示例素材的两张原创示意图原属 M6，范围变更后不自己画（decisions.md M4），先禁用 */}
            <ToggleGroupItem value="sample" disabled aria-label={t('preview.backgrounds.sample')} data-testid="bg-sample" className={cn(item(false), 'disabled:opacity-45')}>
              <ImageIcon size={ICON.md} />
            </ToggleGroupItem>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-56">
            {t('preview.sampleUnavailable')}
          </TooltipContent>
        </Tooltip>
      </ToggleGroup>
      {editor.background === 'solid' && (
        <Popover>
          <PopoverTrigger aria-label={t('preview.solidColor')} className={item(false)}>
            <span className="size-3.5 rounded-[4px]" style={{ background: editor.solidColor }} />
          </PopoverTrigger>
          <PopoverContent side="top" align="center" className="allay-colorful w-[200px]">
            <HexColorPicker color={editor.solidColor} onChange={(c) => set({ solidColor: c.toUpperCase() })} />
          </PopoverContent>
        </Popover>
      )}
      <span className="mx-1 h-4 w-px bg-control-hi" aria-hidden="true" />
      <button
        type="button"
        aria-label={t('preview.guides')}
        title={t('preview.guides')}
        aria-pressed={editor.guides}
        className={item(editor.guides)}
        data-testid="preview-guides-toggle"
        onClick={() => set({ guides: !editor.guides })}
      >
        <FrameCorners size={ICON.md} />
      </button>
      <button
        type="button"
        aria-label={t('transport.hq')}
        title={t('transport.hqHint')}
        aria-pressed={editor.hqPreview}
        className={item(editor.hqPreview)}
        data-testid="transport-hq"
        onClick={() => set({ hqPreview: !editor.hqPreview })}
      >
        <Sparkle size={ICON.md} weight={editor.hqPreview ? ICON_WEIGHT.active : ICON_WEIGHT.normal} />
        {t('preview.hqShort')}
      </button>
    </div>
  );
}

function ErrorCard() {
  const { t, i18n } = useTranslation();
  const status = usePreviewStore((s) => s.status);
  if (status.kind !== 'error' && status.kind !== 'unresponsive' && status.kind !== 'crashed') return null;
  const title = status.kind === 'unresponsive' ? t('preview.unresponsive') : status.kind === 'crashed' ? t('preview.crashed') : t('preview.templateError');
  const issues = status.kind === 'error' && status.issues ? describeLoadIssues(status.issues, useProjectStore.getState().template?.manifest ?? null, (key, vars) => t(key, vars ?? {}), i18n.language) : null;
  const detail = status.kind === 'unresponsive' ? t('preview.unresponsiveHint') : status.message;
  const resetParams = () => {
    const s = useProjectStore.getState();
    if (s.template) s.setTemplate(s.template, {}, i18n.language);
    previewEngine.retry();
  };
  const copy = () => {
    const s = useProjectStore.getState();
    const info = {
      status,
      template: s.template?.ref ?? null,
      params: s.params,
      output: s.output,
      resourceStamp: useResourceStore.getState().state?.stamp ?? null,
      userAgent: navigator.userAgent,
      time: new Date().toISOString(),
    };
    const ok = copyText(JSON.stringify(info, null, 2));
    notify(ok ? 'info' : 'error', ok ? t('preview.diagnosticsCopied') : t('preview.diagnosticsFailed'));
  };
  return (
    <div
      role="alert"
      data-testid="preview-error"
      data-kind={status.kind}
      className="absolute inset-x-6 top-1/2 z-20 mx-auto flex max-w-md -translate-y-1/2 items-start gap-3 rounded-xl bg-surface-2 p-4 text-sm shadow-float"
    >
      <Allay clip="sad" size={48} priority="error" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-base font-semibold text-danger">{title}</p>
        {issues ? (
          <ul className="flex flex-col gap-1 text-xs break-words text-fg-muted" data-testid="preview-error-issues">
            {issues.slice(0, MAX_SHOWN_ISSUES).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
            {issues.length > MAX_SHOWN_ISSUES && <li>{t('preview.issues.more', { count: issues.length - MAX_SHOWN_ISSUES })}</li>}
          </ul>
        ) : (
          <p className="line-clamp-4 num text-xs break-words text-fg-muted">{detail}</p>
        )}
        <div className="mt-1 flex flex-wrap gap-2">
          {status.kind === 'error' ? (
            <Button variant="secondary" onClick={resetParams} data-testid="preview-reset-params">
              {t('preview.resetParams')}
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => previewEngine.retry()} data-testid="preview-retry">
              {t('preview.retry')}
            </Button>
          )}
          <Button variant="ghost" onClick={copy} data-testid="preview-copy-diagnostics">
            {t('preview.copyDiagnostics')}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function PreviewArea() {
  const { t, i18n } = useTranslation();
  const areaRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const output = useProjectStore((s) => s.output);
  const revision = useProjectStore((s) => s.revision);
  const status = usePreviewStore((s) => s.status);
  const editor = useUiStore((s) => s.settings.editor);
  const onboarding = useShowOnboarding();
  const debugLoading = useDebugLoading();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const template = useProjectStore((s) => s.template);
  const usesPlaceholder = usePreviewStore(s => Boolean(s.loaded?.resourceNotices?.includes('catalog-placeholder') || s.loaded?.clipResourceNotices?.some(clip => clip.notices.includes('catalog-placeholder'))));
  const composition = useProjectStore(s => Boolean(s.composition));
  const compactSourceHint = composition || template?.ref.id.startsWith('user.');
  const templateName = template ? localize(template.manifest.name, i18n.language) : null;
  // 适应窗口时的实际缩放比例（画布 CSS 宽度 × 设备像素比 / 输出宽度）
  const zoomPct = size.width > 0 ? Math.round(((size.width * (window.devicePixelRatio || 1)) / output.width) * 100) : null;

  // 画布由 previewEngine 创建并放进这个容器
  useLayoutEffect(() => {
    previewEngine.mount(stageRef.current);
    return () => previewEngine.mount(null);
  }, []);

  // 区域大小或缩放变化 → 画布尺寸
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const update = () => {
      const dpr = window.devicePixelRatio || 1;
      if (editor.zoom === '100') {
        const vp = { cssWidth: Math.round(output.width / dpr), cssHeight: Math.round(output.height / dpr), pixelWidth: output.width, pixelHeight: output.height };
        setSize({ width: vp.cssWidth, height: vp.cssHeight });
        previewEngine.setViewport(vp);
        return;
      }
      const w = area.clientWidth - PREVIEW_INSET.left - PREVIEW_INSET.right;
      const h = area.clientHeight - PREVIEW_INSET.top - PREVIEW_INSET.bottom;
      if (w <= 0 || h <= 0) return;
      const vp = fit(w, h, output.width, output.height, dpr);
      setSize({ width: vp.cssWidth, height: vp.cssHeight });
      previewEngine.setViewport(vp);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(area);
    return () => ro.disconnect();
  }, [output.width, output.height, editor.zoom]);

  // 模板或参数变了 → 重新装载或改参数（首次由 mount 触发）
  useEffect(() => {
    if (revision > 0) previewEngine.reload();
  }, [revision]);

  // 高质量预览：预览也做子帧累积（标准画质）
  useEffect(() => {
    previewEngine.setQuality(editor.hqPreview ? { subframes: 8, shutterAngle: 180 } : undefined);
  }, [editor.hqPreview]);

  // 资源栈变了 → 重新装载（引擎按新的 resourceStamp 清空贴图缓存）
  useEffect(
    () =>
      useResourceStore.subscribe((s, prev) => {
        if (s.state?.stamp !== prev.state?.stamp) previewEngine.reload();
      }),
    [],
  );

  // 时间变了 → 重画
  useEffect(
    () =>
      useTransportStore.subscribe((s, prev) => {
        if (s.time !== prev.time) previewEngine.requestRender(s.time);
      }),
    [],
  );

  const failed = status.kind === 'error' || status.kind === 'unresponsive' || status.kind === 'crashed';
  const loading = status.kind === 'loading' || status.kind === 'starting' || debugLoading;
  return (
    <PreviewViewport
      ref={areaRef}
      label={t('preview.region')}
      stageLabel={t('preview.canvas')}
      stageRef={stageRef}
      background={editor.background === 'sample' ? 'checker' : editor.background}
      solidColor={editor.solidColor}
      guides={editor.guides}
      width={size.width}
      height={size.height}
      scrollable={editor.zoom === '100'}
      title={
        <>
          <b className="text-base font-semibold">{t('preview.title')}</b>
          {templateName && <span className="truncate text-fg-subtle">{templateName}</span>}
          {usesPlaceholder && <span className="truncate text-xs text-fg-subtle" data-testid="catalog-placeholder" title={t('resources.materialSource')}>{t('resources.catalogPlaceholder')}</span>}
        </>
      }
      info={
        <span className="num" data-testid="preview-info">
          {output.width} × {output.height} · {output.fps} fps
        </span>
      }
      toolbar={<Toolbar zoomPct={zoomPct} />}
    >
      {/* 加载编排：视口中央的骨架块 + 飞舞，下方一行状态字（7.5 第 3 项）。整层不接收指针（T-ALY-5） */}
      <div className="pointer-events-none absolute inset-0 z-10" data-testid="preview-loading-layer">
        <AllayLoader loading={loading && !failed} label={t('preview.loading')} priority="preview" className="size-full" testId="preview-loader">
          {loading && !failed ? (
            <div className="flex size-full flex-col items-center justify-center gap-3">
              <Skeleton style={{ width: size.width * 0.6, height: size.height * 0.6 }} />
              <span className="text-xs text-fg-subtle">{t('preview.loading')}</span>
            </div>
          ) : null}
        </AllayLoader>
      </div>
      {onboarding && !failed && !compactSourceHint && <ResourceOnboarding />}
      <ErrorCard />
      <DevOverlay />
    </PreviewViewport>
  );
}
