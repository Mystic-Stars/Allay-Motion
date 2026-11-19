import { DndContext, PointerSensor, pointerWithin, useSensor, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from 'cn';
import { CaretDown, CaretUp, DotsSixVertical, ImageSquare, Plus, X } from '@phosphor-icons/react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '../components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { Input } from '../components/ui/misc';
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover';
import { ICON } from '../lib/icons';
import { useEditor } from './context';
import { entryName, ResourcePickerPopover, ResourceThumb } from './ResourcePicker';
import { ScrubNumberField } from './ScrubNumberField';

// BlockListField 与 TextureField（6.5）。

export interface BlockListEntry {
  id: string;
  weight: number;
}

const RAINBOW_CONCRETE = ['red', 'orange', 'yellow', 'lime', 'light_blue', 'blue', 'purple'].map((color) => `minecraft:${color}_concrete`);
const SHORT_LIST_LIMIT = 3;
const SUMMARY_LIMIT = 7;
const quietAction = 'text-fg-subtle opacity-70 group-hover/block:opacity-100 group-focus-within/block:opacity-100';
const quietDrag = () => undefined;
const dragAccessibility = { announcements: { onDragStart: quietDrag, onDragOver: quietDrag, onDragEnd: quietDrag, onDragCancel: quietDrag } };

function SortableBlockRow({ id, name, children, canMove, onMove }: { id: number; name: string; children: ReactNode; canMove: [boolean, boolean]; onMove(delta: number, button: HTMLButtonElement): void }) {
  const { t } = useEditor();
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition, isDragging } = useSortable({ id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('group/block relative flex h-8 min-w-0 items-center gap-0.5 rounded-md bg-control pr-1', isDragging && 'z-10 shadow-float')}
    >
      <span
        ref={setActivatorNodeRef}
        {...listeners}
        title={t('blockList.drag', { name })}
        aria-hidden="true"
        className={cn('flex h-8 w-6 shrink-0 touch-none cursor-grab items-center justify-center active:cursor-grabbing', quietAction)}
      >
        <DotsSixVertical size={ICON.md} />
      </span>
      {children}
      {canMove.some(Boolean) && ([CaretUp, CaretDown] as const).map((Icon, index) => {
        const label = t(index === 0 ? 'blockList.moveUp' : 'blockList.moveDown', { name });
        return (
          <Button key={index} type="button" size="icon-sm" variant="ghost" aria-label={label} title={label} aria-disabled={!canMove[index]} className={cn(quietAction, 'aria-disabled:opacity-45')} onClick={(event) => canMove[index] && onMove(index === 0 ? -1 : 1, event.currentTarget)}>
            <Icon size={ICON.xs} />
          </Button>
        );
      })}
    </li>
  );
}

/** BlockListField：多个方块芯片，每个带权重，可增删和排序 */
export function BlockListField({ value, onChange, max = 64, label, testId }: { value: readonly BlockListEntry[]; onChange(v: BlockListEntry[]): void; max?: number; label: string; testId?: string }) {
  const editor = useEditor();
  const dndId = useId();
  const listId = useId();
  const pointerSensor = useSensor(PointerSensor, { activationConstraint: { distance: 4 } });
  const [slots, setSlots] = useState(() => Array.from({ length: 64 }, (_, index) => index));
  const [announcement, setAnnouncement] = useState('');
  const [expanded, setExpanded] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const focusAfterEdit = useRef<HTMLElement | 'last' | null>(null);
  const long = value.length > SHORT_LIST_LIMIT;
  const showRows = !long || expanded;
  const byId = useMemo(() => new Map(editor.blocks.map((b) => [b.id, b])), [editor.blocks]);
  const names = value.map(({ id }) => entryName(byId.get(id), id, editor.locale));
  const supportsRainbow = max >= RAINBOW_CONCRETE.length && RAINBOW_CONCRETE.every((id) => byId.has(id));
  const rowIds = slots.slice(0, value.length);
  useLayoutEffect(() => {
    const next = focusAfterEdit.current;
    focusAfterEdit.current = null;
    if (next === 'last') {
      (expandButton.current ?? list.current?.lastElementChild?.querySelector('button'))?.focus();
    } else {
      next?.focus({ preventScroll: true });
    }
  }, [slots, value]);
  const update = (i: number, patch: Partial<BlockListEntry>) => onChange(value.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  const reorder = (from: number, to: number) => {
    if (from < 0 || to < 0 || to >= value.length || from === to) return;
    setSlots(arrayMove(slots, from, to));
    onChange(arrayMove([...value], from, to));
    setAnnouncement(editor.t('blockList.moved', { name: names[from]!, position: to + 1 }));
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over) reorder(rowIds.indexOf(Number(active.id)), rowIds.indexOf(Number(over.id)));
  };
  return (
    <div className="flex min-w-0 flex-col gap-1" role="group" aria-label={label} data-testid={testId}>
      {(long || expanded) && (
        <div className="flex flex-wrap items-center justify-between gap-x-1">
          {!showRows && (
            <div role="img" aria-label={names.join(', ')} className="flex items-center gap-0.5 rounded-md bg-control px-1 py-1">
              {value.slice(0, SUMMARY_LIMIT).map(({ id }, index) => (
                <span key={rowIds[index]} title={names[index]}><ResourceThumb kind="block" id={id} size={16} className="rounded-sm" /></span>
              ))}
              {value.length > SUMMARY_LIMIT && <span aria-hidden="true" className="num px-0.5 text-xs text-fg-subtle">+{value.length - SUMMARY_LIMIT}</span>}
            </div>
          )}
          <Button ref={expandButton} variant="ghost" size="sm" className="ml-auto" aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(!expanded)}>
            {expanded ? <CaretUp size={ICON.xs} /> : <CaretDown size={ICON.xs} />}
            {editor.t(expanded ? 'blockList.collapse' : 'blockList.editOrder')}
          </Button>
        </div>
      )}
      <DndContext id={dndId} sensors={[pointerSensor]} collisionDetection={pointerWithin} onDragEnd={onDragEnd} accessibility={dragAccessibility}>
        <SortableContext items={showRows ? rowIds : []} strategy={verticalListSortingStrategy}>
          <ol id={listId} ref={list} className={showRows ? 'flex flex-col gap-1' : undefined} hidden={!showRows}>
            {showRows && value.map((entry, index) => {
              const name = names[index]!;
              return (
                <SortableBlockRow key={rowIds[index]} id={rowIds[index]!} name={name} canMove={[index > 0, index + 1 < value.length]} onMove={(delta, button) => {
                  focusAfterEdit.current = button;
                  reorder(index, index + delta);
                }}>
                  <ResourcePickerPopover
                    kind="block"
                    value={entry.id}
                    label={editor.t('blockList.replace', { name })}
                    onPick={(id) => update(index, { id })}
                    trigger={
                      <PopoverTrigger aria-label={editor.t('blockList.replace', { name })} className="flex h-control min-w-0 flex-1 items-center gap-2 rounded-md text-left text-foreground hover:bg-control-hi">
                        <ResourceThumb kind="block" id={entry.id} size={22} className="rounded-[4px]" />
                        <span className="truncate" title={entry.id}>{name}</span>
                      </PopoverTrigger>
                    }
                  />
                  <ScrubNumberField
                    value={entry.weight}
                    onChange={(weight) => update(index, { weight })}
                    min={0}
                    max={1000}
                    step={0.1}
                    decimals={1}
                    label={editor.t('blockList.weight', { name })}
                    lead={<span className="num">×</span>}
                    bare
                    className="w-14 shrink-0"
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className={quietAction}
                    aria-label={editor.t('blockList.remove', { name })}
                    disabled={value.length <= 1}
                    onClick={() => {
                      const neighbor = list.current?.children[index + (index + 1 < value.length ? 1 : -1)];
                      focusAfterEdit.current = neighbor?.querySelector('button') ?? null;
                      setSlots(arrayMove(slots, index, slots.length - 1));
                      onChange(value.filter((_, entryIndex) => entryIndex !== index));
                    }}
                  >
                    <X size={ICON.xs} />
                  </Button>
                </SortableBlockRow>
              );
            })}
          </ol>
        </SortableContext>
      </DndContext>
      <span role="status" className="sr-only">{announcement}</span>
      <div className="flex flex-wrap items-center gap-0.5">
      {value.length < max && (
        <ResourcePickerPopover
          kind="block"
          value={null}
          label={editor.t('blockList.add')}
          onPick={(id) => {
            if (value.length + 1 === max) focusAfterEdit.current = 'last';
            onChange([...value, { id, weight: 1 }]);
          }}
          trigger={
            <PopoverTrigger render={<Button variant="ghost" size="sm" />} data-testid={testId ? `${testId}-add` : undefined}>
              <Plus size={ICON.xs + 1} />
              {editor.t('blockList.add')}
            </PopoverTrigger>
          }
        />
      )}
      {supportsRainbow && (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>
            {editor.t('blockList.presets')} <CaretDown size={ICON.xs} />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem
              title={editor.t('blockList.rainbowHint')}
              data-testid={testId ? `${testId}-rainbow` : undefined}
              onClick={() => {
                onChange(RAINBOW_CONCRETE.map((id) => ({ id, weight: 1 })));
                setExpanded(false);
                setAnnouncement(editor.t('blockList.rainbowApplied'));
              }}
            >
              {editor.t('blockList.rainbow')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      </div>
    </div>
  );
}

function TexturePreview({ value, size = 20 }: { value: string; size?: number }) {
  const editor = useEditor();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (value) void editor.texturePreview(value).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [value, editor, editor.resourceStamp]);
  return url ? (
    <img src={url} alt="" width={size} height={size} className="pixelated shrink-0 rounded-[3px] object-contain" />
  ) : (
    <span className="shrink-0 rounded-[3px] bg-skeleton" style={{ width: size, height: size }} aria-hidden="true" />
  );
}

/** 显示用的名字：file: 引用显示文件名，asset: 显示路径，资源 ID 原样 */
function textureLabel(value: string, fileNames: Readonly<Record<string, string>>, none: string): string {
  if (!value) return none;
  if (value.startsWith('file:')) return fileNames[value] ?? value.slice(5, 13);
  if (value.startsWith('asset:')) return value.slice(6);
  return value;
}

/** TextureField：从资源栈按 ID 选，或导入本地图片（allowFile 时） */
export function TextureField({
  value,
  onChange,
  allowFile,
  fileNames = {},
  label,
  testId,
}: {
  value: string;
  onChange(v: string): void;
  allowFile?: boolean;
  /** file: 引用对应的文件名（只用于显示） */
  fileNames?: Readonly<Record<string, string>>;
  label: string;
  testId?: string;
}) {
  const editor = useEditor();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ids = useMemo(() => editor.textureIds.filter((id) => !q || id.includes(q.toLowerCase())).slice(0, 300), [editor.textureIds, q]);
  return (
    <div className="flex min-w-0 items-center gap-1" data-testid={testId}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger aria-label={label} className="inline-flex h-control min-w-0 flex-1 items-center gap-2 rounded-md bg-control px-1 text-sm hover:bg-control-hi">
          <TexturePreview value={value} />
          <span className="truncate num text-xs">{textureLabel(value, fileNames, editor.t('texture.none'))}</span>
        </PopoverTrigger>
        <PopoverContent side="left" align="start" className="w-[304px]" aria-label={label}>
          <div className="flex flex-col gap-2">
            <Input autoFocus value={q} onChange={(e) => setQ(e.currentTarget.value)} placeholder={editor.t('texture.search')} aria-label={editor.t('texture.search')} />
            <div className="grid max-h-[260px] grid-cols-7 gap-0.5 overflow-y-auto" role="listbox" aria-label={editor.t('texture.fromStack')}>
              {ids.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="option"
                  aria-selected={value === id}
                  title={id}
                  aria-label={id}
                  className={cn('flex size-10 items-center justify-center rounded-md hover:bg-control', value === id && 'bg-primary-soft shadow-[inset_0_0_0_1.5px_var(--primary)]')}
                  onClick={() => {
                    onChange(id);
                    setOpen(false);
                  }}
                >
                  <TexturePreview value={id} size={32} />
                </button>
              ))}
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {allowFile && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={editor.t('texture.import')}
          title={editor.t('texture.import')}
          onClick={() =>
            void editor.pickImage().then((picked) => {
              if (picked) onChange(picked.value);
            })
          }
        >
          <ImageSquare size={ICON.md} />
        </Button>
      )}
    </div>
  );
}
