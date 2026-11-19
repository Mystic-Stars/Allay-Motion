export function trackEditorPointer(
  element: Element,
  pointerId: number,
  onMove: (event: PointerEvent) => void,
  onFinish: (event: PointerEvent | null) => void,
): () => void {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // 合成指针没有捕获目标时仍可由窗口跟踪。
  }
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const stop = () => {
    controller.abort();
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  };
  const finish = (event: PointerEvent | null) => {
    stop();
    onFinish(event);
  };
  window.addEventListener('pointermove', (event) => {
    if (event.pointerId === pointerId) onMove(event);
  }, options);
  window.addEventListener('pointerup', (event) => {
    if (event.pointerId === pointerId) finish(event);
  }, options);
  window.addEventListener('pointercancel', (event) => {
    if (event.pointerId === pointerId) finish(null);
  }, options);
  element.addEventListener('lostpointercapture', (event) => {
    if (event instanceof PointerEvent && event.pointerId === pointerId) finish(null);
  }, options);
  window.addEventListener('blur', () => finish(null), options);
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    finish(null);
  }, { ...options, capture: true });
  return stop;
}
