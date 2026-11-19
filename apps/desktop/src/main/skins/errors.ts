import type { SkinErrorCode } from '../../shared/skins';

export class SkinError extends Error {
  constructor(readonly code: SkinErrorCode) {
    super(code);
  }
}
