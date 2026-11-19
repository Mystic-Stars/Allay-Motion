import { sameValue } from '@allay/template-sdk';
import { beginGesture, endGesture, useProjectStore } from '../../stores/projectStore';

export function startSegmentGesture(): () => void {
  const before = useProjectStore.getState();
  beginGesture();
  return () => {
    const after = useProjectStore.getState();
    if (before.params !== after.params && before.structureRevision === after.structureRevision && before.handle === after.handle &&
      Object.keys(before.params).every((key) => sameValue(before.params[key], after.params[key]))) {
      const unchanged = before.output === after.output && before.exportSettings === after.exportSettings && before.savedRevision === after.savedRevision;
      useProjectStore.setState({
        params: before.params,
        origin: before.origin,
        savedRevision: unchanged && before.revision === before.savedRevision ? after.revision : after.savedRevision,
      });
    }
    endGesture();
  };
}
