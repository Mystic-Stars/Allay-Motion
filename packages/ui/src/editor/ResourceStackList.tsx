import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cn } from 'cn';
import { DotsSixVertical, Package, Trash, Warning } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/misc';
import { Switch } from '../components/ui/switch';
import { ICON } from '../lib/icons';

// ResourceStackList（6.4 资源栈弹层）：自上而下列出各层，与解析顺序一致。每行：拖动手柄、32 px 的包图标（像素化显示）、
// 名称、一行描述、类型徽标、开关、删除。只有资源包能拖（原版层固定在资源包之下，内置层不能拖、不能关）。
// 拖拽排序用 dnd-kit，键盘可用（聚焦手柄，空格拿起，上下键移动，空格放下）。

export interface StackRow {
  id: string;
  name: string;
  description: string;
  kindLabel: string;
  iconUrl: string | null;
  enabled: boolean;
  sortable: boolean;
  /** 能不能关；提供移除动作时也决定能不能删 */
  locked: boolean;
  toggleDisabled?: boolean;
  /** 一句问题说明（旧格式、跳过的文件等） */
  warning?: string;
}

export interface ResourceStackListProps {
  rows: readonly StackRow[];
  /** 资源包从上到下的新顺序 */
  onReorder(idsTopToBottom: string[]): void;
  onToggle(id: string, enabled: boolean): void;
  onRemove?(id: string): void;
  renderLabel?(row: StackRow): ReactNode;
  labels: { drag(name: string): string; toggle(name: string): string; remove(name: string): string };
}

function Row({ row, labels, onToggle, onRemove, renderLabel }: { row: StackRow } & Pick<ResourceStackListProps, 'labels' | 'onToggle' | 'onRemove' | 'renderLabel'>) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: row.id, disabled: !row.sortable });
  return (
    <li
      ref={setNodeRef}
      data-testid="layer-row"
      data-layer-id={row.id}
      data-enabled={row.enabled}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('relative flex items-center gap-2 rounded-lg py-1.5 pr-1 pl-0.5 hover:bg-control', isDragging && 'z-10 bg-surface-2 shadow-float')}
    >
      {row.sortable ? (
        <button
          ref={setActivatorNodeRef}
          type="button"
          aria-label={labels.drag(row.name)}
          data-testid="layer-drag"
          className="inline-flex h-8 w-5 shrink-0 cursor-grab items-center justify-center text-fg-muted hover:text-foreground"
          {...attributes}
          {...listeners}
        >
          <DotsSixVertical size={ICON.md} />
        </button>
      ) : (
        <span className="w-5 shrink-0" aria-hidden="true" />
      )}
      <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-well">
        {row.iconUrl ? <img src={row.iconUrl} alt="" className="pixelated size-8" /> : <Package size={ICON.md} className="text-fg-subtle" aria-hidden="true" />}
      </span>
      <div className="min-w-0 flex-1">
        {renderLabel?.(row) ?? (
          <>
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm" title={row.name}>{row.name}</span>
              <Badge className="shrink-0">{row.kindLabel}</Badge>
            </div>
            {row.description && <p className="truncate text-xs text-fg-subtle" title={row.description}>{row.description}</p>}
          </>
        )}
        {row.warning && (
          <p className="flex items-center gap-1 text-xs text-warning" data-testid="layer-warning">
            <Warning size={ICON.sm} className="shrink-0" aria-hidden="true" />
            <span className="truncate" title={row.warning}>
              {row.warning}
            </span>
          </p>
        )}
      </div>
      {!row.locked && (
        <>
          <Switch checked={row.enabled} disabled={row.toggleDisabled} onCheckedChange={(v) => onToggle(row.id, v)} aria-label={labels.toggle(row.name)} data-testid="layer-toggle" className="mx-1" />
          {onRemove && <Button variant="ghost" size="icon-sm" aria-label={labels.remove(row.name)} data-testid="layer-remove" onClick={() => onRemove(row.id)}>
            <Trash size={ICON.md} />
          </Button>}
        </>
      )}
    </li>
  );
}

export function ResourceStackList({ rows, onReorder, onToggle, onRemove, renderLabel, labels }: ResourceStackListProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const sortableIds = rows.filter((r) => r.sortable).map((r) => r.id);
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = sortableIds.indexOf(String(active.id));
    const to = sortableIds.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(sortableIds, from, to));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        <ul className="flex flex-col gap-1" data-testid="resource-stack-list">
          {rows.map((r) => (
            <Row key={r.id} row={r} labels={labels} onToggle={onToggle} onRemove={onRemove} renderLabel={renderLabel} />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}
