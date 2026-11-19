import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from 'cn';
import { CaretDown, CloudArrowDown, MagnifyingGlass, Play, Prohibit } from '@phosphor-icons/react';
import { useMemo, useRef, useState } from 'react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/misc';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { ICON } from '../lib/icons';
import { useEditor, type SoundLibraryItem } from './context';

// SoundField（6.5）：音效和音乐可按两种语言的名称或 ID 搜索，常用事件置顶。

const ROW = 42;
const HEADER = 24;

type Row = { kind: 'header'; label: string } | { kind: 'none' } | { kind: 'sound'; item: SoundLibraryItem };

/** 优先显示当前语言的名称，没有名称时保留完整 ID。 */
export function useSoundName(): (id: string) => string {
  const { sounds, locale, t } = useEditor();
  return useMemo(() => {
    const byId = new Map(sounds.library.map((item) => [item.id, item]));
    const common = new Set(sounds.common);
    const language = locale.startsWith('zh') ? 'zh-CN' : 'en';
    return (id: string) => {
      const item = byId.get(id);
      return item?.names[language] ?? ((!item || item.source === 'vanilla' || item.source === 'definition-override' || item.source === 'file-override') && common.has(id) ? t(`sound.names.${id.replace(/[:.]/g, '_')}`, { id }) : id);
    };
  }, [sounds.library, sounds.common, locale, t]);
}

function StateIcon({ state, label }: { state: SoundLibraryItem['state']; label: string }) {
  if (state === 'local') return null;
  const Icon = state === 'remote' ? CloudArrowDown : Prohibit;
  return (
    <span title={label} aria-label={label} className="inline-flex shrink-0 text-fg-subtle" data-state={state}>
      <Icon size={ICON.sm} />
    </span>
  );
}

function SoundList({ value, onPick }: { value: string | null; onPick(id: string | null): void }) {
  const editor = useEditor();
  const name = useSoundName();
  const [q, setQ] = useState('');
  const [importing, setImporting] = useState(false);
  const [fetchingNames, setFetchingNames] = useState(false);
  const { library, common } = editor.sounds;
  const rows = useMemo<Row[]>(() => {
    const s = q.trim().normalize('NFKC').toLowerCase();
    const match = (item: SoundLibraryItem) => !s || [item.id, item.names['zh-CN'], item.names.en, name(item.id)].some((label) => label?.normalize('NFKC').toLowerCase().includes(s));
    const out: Row[] = [];
    if (!s) out.push({ kind: 'none' });
    const byId = new Map(library.map((i) => [i.id, i]));
    const pinned = common.map((id) => byId.get(id)).filter((i): i is SoundLibraryItem => !!i && match(i));
    if (pinned.length > 0) {
      out.push({ kind: 'header', label: editor.t('sound.common') });
      for (const item of pinned) out.push({ kind: 'sound', item });
    }
    const pinnedIds = new Set(pinned.map(({ id }) => id));
    for (const kind of ['effect', 'music'] as const) {
      const matches = library.filter((item) => item.kind === kind && !pinnedIds.has(item.id) && match(item));
      if (!matches.length) continue;
      out.push({ kind: 'header', label: editor.t(`sound.kind.${kind}`) });
      for (const item of matches) out.push({ kind: 'sound', item });
    }
    return out;
  }, [q, library, common, editor, name]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]!.kind === 'header' ? HEADER : ROW),
    overscan: 8,
  });
  const anySound = rows.some((r) => r.kind === 'sound');
  const stateLabel = (state: SoundLibraryItem['state']) => editor.t(state === 'remote' ? 'sound.remote' : 'sound.unavailable');
  async function pickImport(kind: SoundLibraryItem['kind']) {
    setImporting(true);
    try {
      const id = await editor.importSound?.(kind);
      if (id) onPick(id);
    } finally {
      setImporting(false);
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <MagnifyingGlass size={ICON.sm} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
        <Input autoFocus value={q} onChange={(event) => { setQ(event.currentTarget.value); scrollRef.current?.scrollTo({ top: 0 }); }} placeholder={editor.t('picker.search')} aria-label={editor.t('picker.search')} className="pl-8" data-testid="sound-search" />
      </div>
      {editor.importSound && (
        <div className="flex gap-1">
          <Button size="xs" variant="secondary" disabled={importing} onClick={() => void pickImport('effect')}>{editor.t('sound.importEffect')}</Button>
          <Button size="xs" variant="secondary" disabled={importing} onClick={() => void pickImport('music')}>{editor.t('sound.importMusic')}</Button>
        </div>
      )}
      {editor.fetchSoundNames && (
        <Button size="xs" variant="secondary" disabled={fetchingNames} onClick={async () => {
          setFetchingNames(true);
          try { await editor.fetchSoundNames?.(); } finally { setFetchingNames(false); }
        }}>
          {editor.t('sound.downloadNames')}
        </Button>
      )}
      {library.length === 0 && (
        <div className="flex items-center justify-between gap-2 rounded-md bg-control px-2.5 py-1.5 text-xs text-fg-muted" data-testid="sound-library-empty">
          <span>{editor.t(editor.sounds.loading ? 'sound.loading' : 'sound.noLibrary')}</span>
          {!editor.sounds.loading && editor.openResources && (
            <Button size="xs" variant="secondary" onClick={editor.openResources}>
              {editor.t('picker.addAssets')}
            </Button>
          )}
        </div>
      )}
      <div ref={scrollRef} className="h-[300px] overflow-y-auto" role="listbox" aria-label={editor.t('sound.library')} data-testid="sound-list">
        {!anySound && library.length > 0 && q && <p className="py-6 text-center text-xs text-fg-muted">{editor.t('picker.empty', { q })}</p>}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const row = rows[vi.index]!;
            return (
              <div key={vi.key} className="absolute inset-x-0" style={{ transform: `translateY(${vi.start}px)`, height: vi.size }}>
                {row.kind === 'header' ? (
                  <div className="flex h-6 items-end px-1 pb-1 text-xs text-fg-subtle">{row.label}</div>
                ) : row.kind === 'none' ? (
                  <button
                    type="button"
                    role="option"
                    aria-selected={value === null}
                    data-testid="sound-none"
                    className={cn('flex h-7 w-full items-center rounded-md px-2 text-left text-sm hover:bg-control', value === null && 'bg-primary-soft')}
                    onClick={() => onPick(null)}
                  >
                    {editor.t('sound.none')}
                  </button>
                ) : (
                  <button
                    type="button"
                    role="option"
                    aria-selected={value === row.item.id}
                    title={row.item.id}
                    data-testid={`sound-${row.item.id}`}
                    data-state={row.item.state}
                    className={cn(
                      'flex h-10 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-control',
                      value === row.item.id && 'bg-primary-soft',
                      row.item.state === 'missing' && 'text-fg-subtle',
                    )}
                    onClick={() => onPick(row.item.id)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{name(row.item.id)}</span>
                      <span className="block truncate text-xs text-fg-muted">
                        {editor.t(`sound.source.${row.item.source}`)}
                        {row.item.fileOverride && row.item.source !== 'file-override' && ` · ${editor.t('sound.source.file-override')}`}
                        {row.item.names.chinese === 'missing' && ` · ${editor.t('sound.missingChinese')}`}
                        {row.item.variantCount > 1 && ` · ${editor.t('sound.variants', { count: row.item.variantCount })}`}
                      </span>
                    </span>
                    <StateIcon state={row.item.state} label={stateLabel(row.item.state)} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** SoundField：选择器加试听按钮（宿主给了 previewSound 才能试听，否则按钮禁用） */
export function SoundField({ value, onChange, label, testId }: { value: string | null; onChange(v: string | null): void; label: string; testId?: string }) {
  const editor = useEditor();
  const name = useSoundName();
  const [open, setOpen] = useState(false);
  const state = value ? editor.sounds.library.find((i) => i.id === value)?.state : undefined;
  return (
    <div className="flex min-w-0 items-center gap-1" data-testid={testId}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          aria-label={label}
          data-testid={testId ? `${testId}-trigger` : undefined}
          className="inline-flex h-control min-w-0 flex-1 items-center gap-1.5 rounded-md bg-control px-2.5 text-sm hover:bg-control-hi"
        >
          <span className="min-w-0 flex-1 truncate text-left">{value === null ? editor.t('sound.none') : name(value)}</span>
          {value !== null && state !== 'local' && <StateIcon state={state ?? 'missing'} label={editor.t(state === 'remote' ? 'sound.remote' : 'sound.unavailable')} />}
          <CaretDown size={ICON.sm} className="shrink-0 text-fg-subtle" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent side="left" align="start" className="w-[304px]" aria-label={label}>
          {open && (
            <SoundList
              value={value}
              onPick={(id) => {
                // 选中下载缓存里还没取的音效：宿主按需取回（用户操作触发，decisions.md M6b）
                if (id) editor.prepareSound?.(id);
                onChange(id);
                setOpen(false);
              }}
            />
          )}
        </PopoverContent>
      </Popover>
      <Button
        variant="secondary"
        size="icon-sm"
        className="text-fg-muted"
        aria-label={editor.t('sound.preview')}
        title={editor.previewSound ? editor.t('sound.preview') : editor.t('sound.previewLater')}
        disabled={!editor.previewSound || value === null}
        onClick={() => value && editor.previewSound?.(value)}
        data-testid={testId ? `${testId}-preview` : undefined}
      >
        <Play size={ICON.sm} weight="fill" />
      </Button>
    </div>
  );
}
