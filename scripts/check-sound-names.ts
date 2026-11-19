import { readFile } from 'node:fs/promises';
import { missingVanillaSoundNames, parseSoundLanguage, parseSoundsJson, soundNames } from '../packages/assets/src/index';

const [definitionsPath, languagePath] = process.argv.slice(2);
if (!definitionsPath || !languagePath) {
  console.error('用法：pnpm exec tsx scripts/check-sound-names.ts <同版本的原版 sounds.json> <本机 zh_cn.json>');
  process.exitCode = 2;
} else {
  const [definitions, language] = await Promise.all([readFile(definitionsPath, 'utf8'), readFile(languagePath, 'utf8')]);
  const { events } = parseSoundsJson(definitions, 'minecraft');
  const zh = parseSoundLanguage(language);
  const rows = [...events].map(([id, event]) => ({ id, names: soundNames(id, true, event.subtitle, zh, {}) }));
  const missing = missingVanillaSoundNames(rows);
  const withoutSubtitle = missingVanillaSoundNames(rows.filter(({ id }) => !events.get(id)?.subtitle));
  const subtitleCount = rows.filter(({ names }) => names.chinese === 'subtitle').length;
  console.log(`事件 ${rows.length}，正式字幕 ${subtitleCount}，术语补充 ${rows.length - subtitleCount - missing.length}，缺译 ${missing.length}（无字幕的缺译 ${withoutSubtitle.length}）`);
  if (missing.length) console.log(missing.join('\n'));
  if (!rows.length || !subtitleCount || missing.length) process.exitCode = 1;
}
