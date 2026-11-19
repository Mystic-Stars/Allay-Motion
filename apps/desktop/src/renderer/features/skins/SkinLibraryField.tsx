import { Button } from '@allay/ui/components/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle, DialogTrigger } from '@allay/ui/components/dialog';
import { fieldClass, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@allay/ui/components/select';
import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { JavaNameSchema, SkinAddResultSchema, SkinEntrySchema, type SkinAddResult, type SkinEntry, type SkinErrorCode, type SkinModel } from '../../../shared/skins';
import { skinCopy } from './copy';

const SkinList = z.array(SkinEntrySchema);

export function SkinLibraryField({ value, language, onSelect }: { value: string; language: string; onSelect(entry: SkinEntry | null): void }) {
  const locale = language.startsWith('zh') ? 'zh-CN' : 'en';
  const copy = skinCopy[locale];
  const api = window.allay.skins;
  const playerInput = useId();
  const nameError = useId();
  const title = useId();
  const done = useRef<HTMLButtonElement>(null);
  const [entries, setEntries] = useState<SkinEntry[] | null>(null);
  const [model, setModel] = useState<SkinModel>('classic');
  const [player, setPlayer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SkinErrorCode | null>(null);
  const [manage, setManage] = useState(false);
  const [confirm, setConfirm] = useState<SkinEntry | null>(null);

  useEffect(() => {
    if (!api) return;
    let live = true;
    void api.list().then((raw) => {
      if (live) setEntries(SkinList.parse(raw));
    }).catch(() => { if (live) setError('storage'); });
    return () => { live = false; };
  }, [api]);

  if (!api) return <p className="px-3.5 py-3 text-xs text-fg-subtle">{copy.unsupported}</p>;
  const selected = entries?.find((entry) => entry.ref === value);
  const missing = !!value && !!entries && !selected;
  const invalidName = player.trim().length > 0 && !JavaNameSchema.safeParse(player.trim()).success;

  const add = async (run: () => Promise<SkinAddResult>) => {
    setBusy(true);
    setError(null);
    try {
      const result = SkinAddResultSchema.parse(await run());
      if (result.status === 'error') setError(result.code);
      if (result.status === 'added') {
        const { entry } = result;
        setEntries((current) => [...(current ?? []), entry].sort((left, right) => left.name.localeCompare(right.name, locale)));
        onSelect(entry);
      }
    } catch {
      setError('storage');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entry: SkinEntry) => {
    setBusy(true);
    setError(null);
    try {
      await api.remove(entry.ref);
      setEntries((current) => current?.filter((item) => item.ref !== entry.ref) ?? []);
      onSelect(null);
    } catch {
      setError('storage');
    } finally {
      setConfirm(null);
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={title} className="flex flex-col gap-1 border-b border-divider px-3.5 pt-1 pb-3" data-testid="skin-library">
      <div className="flex min-w-0 items-center gap-2">
        <span id={title} className="w-[30%] shrink-0 truncate text-sm text-fg-muted">{copy.field}</span>
        <Select value={value} disabled={busy || !entries} onValueChange={(ref) => onSelect(entries?.find((entry) => entry.ref === ref) ?? null)}>
          <SelectTrigger className="flex-1" aria-labelledby={title} aria-invalid={missing || undefined} title={selected?.name} data-testid="skin-library-select">
            <SelectValue className="truncate">{selected?.name ?? (missing ? copy.missingShort : copy.none)}</SelectValue>
          </SelectTrigger>
          <SelectContent className="max-w-(--available-width)">
            <SelectItem value="">{copy.none}</SelectItem>
            {missing && <SelectItem value={value} disabled>{copy.missingShort}</SelectItem>}
            {entries?.map((entry) => <SelectItem key={entry.ref} value={entry.ref} label={entry.name}><span className="truncate">{entry.name}</span><span className="text-xs text-fg-subtle">{copy[entry.height === 32 ? 'legacy' : entry.model]} · {copy[entry.source]}</span></SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <Dialog open={manage} onOpenChange={(open) => { if (!busy) setManage(open); }}>
        <DialogTrigger render={<Button variant="ghost" size="sm" className="self-end" />}>{copy.manage}</DialogTrigger>
        <DialogContent showClose={false} className="overflow-y-auto" aria-busy={busy}>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{missing ? copy.missing : !selected ? copy.empty : copy.description}</DialogDescription>
          <div className="flex flex-col gap-2">
            <p className="text-xs text-fg-subtle">{copy.formats}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={model} disabled={busy || !entries} onValueChange={(next) => { if (next === 'classic' || next === 'slim') setModel(next); }}>
                <SelectTrigger aria-label={copy.model}><SelectValue>{copy[model]}</SelectValue></SelectTrigger>
                <SelectContent><SelectItem value="classic">{copy.classic}</SelectItem><SelectItem value="slim">{copy.slim}</SelectItem></SelectContent>
              </Select>
              <Button variant="secondary" aria-disabled={busy || !entries} onClick={() => { if (!busy && entries) void add(() => api.importPng(model)); }} data-testid="skin-import">{copy.import}</Button>
            </div>
          </div>
          <div className="flex flex-col gap-2 border-t border-divider pt-3">
            <label htmlFor={playerInput} className="text-xs text-fg-muted">{copy.player}</label>
            <input id={playerInput} className={fieldClass} value={player} maxLength={16} autoComplete="off" spellCheck={false} readOnly={busy} aria-invalid={invalidName} aria-describedby={nameError} onChange={(event) => setPlayer(event.currentTarget.value)} />
            <p id={nameError} className="text-xs text-fg-subtle">{invalidName ? copy.nameHint : copy.fetchHint}</p>
            <Button variant="secondary" className="self-start" aria-disabled={busy || !entries || !player.trim() || invalidName} onClick={() => {
              if (!busy && entries && !invalidName && player.trim()) void add(() => api.fetchJava(player.trim(), locale));
            }} data-testid="skin-fetch-java">{copy.fetch}</Button>
          </div>
          <Dialog open={!!confirm} onOpenChange={(open) => { if (!busy) setConfirm(open ? selected ?? null : null); }}>
            {selected && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-divider pt-3">
                <span className="min-w-0 break-all text-xs text-fg-subtle">{selected.name} · <span className="num">64×{selected.height}</span> · {copy[selected.height === 32 ? 'legacy' : selected.model]} · {copy[selected.source]}</span>
                <DialogTrigger render={<Button variant="ghost" size="sm" disabled={busy} />}>{copy.remove}</DialogTrigger>
              </div>
            )}
            <DialogContent showClose={false} finalFocus={done}>
              <DialogTitle>{copy.removeTitle}</DialogTitle>
              <DialogDescription>{confirm?.name} — {copy.removeDetail}</DialogDescription>
              <DialogFooter>
                <DialogClose render={<Button variant="secondary" aria-disabled={busy} />}>{copy.cancel}</DialogClose>
                <Button variant="destructive" aria-disabled={busy} onClick={() => { if (!busy && confirm) void remove(confirm); }}>{copy.confirmRemove}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          {busy && <p role="status" className="text-xs text-fg-muted">{copy.loading}</p>}
          {error && <p role="alert" className="text-xs text-destructive">{copy.errors[error]}</p>}
          <DialogFooter>
            <DialogClose ref={done} render={<Button variant="secondary" aria-disabled={busy} />}>{copy.done}</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
