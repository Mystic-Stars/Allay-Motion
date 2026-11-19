import { builtinId, ORIGINAL_BUILTIN_NAMES } from './builtin-template-names';

export const catalogNames = [...ORIGINAL_BUILTIN_NAMES].sort();
export const catalogIds = catalogNames.map(builtinId).sort();
