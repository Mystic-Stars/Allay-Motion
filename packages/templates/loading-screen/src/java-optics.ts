const END_TINT_RGB = [
  [0.022087, 0.098399, 0.110818], [0.011892, 0.095924, 0.089485], [0.027636, 0.101689, 0.100326],
  [0.046564, 0.109883, 0.114838], [0.064901, 0.117696, 0.097189], [0.063761, 0.086895, 0.123646],
  [0.084817, 0.111994, 0.166380], [0.097489, 0.154120, 0.091064], [0.106152, 0.131144, 0.195191],
  [0.097721, 0.110188, 0.187229], [0.133516, 0.138278, 0.148582], [0.070006, 0.243332, 0.235792],
  [0.196766, 0.142899, 0.214696], [0.047281, 0.315338, 0.321970], [0.204675, 0.390010, 0.302066],
] as const;

export const END_LAYERS = END_TINT_RGB.map((tint, index) => {
  const depth = index + 1;
  const angle = ((depth * (8642 * depth + 18)) % 360) * Math.PI / 180;
  const magnification = 4.5 - depth / 4;
  return {
    tint, basisX: Math.cos(angle) * magnification, basisY: Math.sin(angle) * magnification,
    offsetX: 0.25 + 8.5 / depth, clockWeight: 1.5 + depth / 2,
  };
});

export function endClock(time: number, motion: boolean, startTick: number): number {
  return (startTick + (motion ? Math.max(0, time) * 20 : 0)) % 24000 / 24000;
}

export function panoramaBlurKernel(radius: number): number[] {
  let kernel = [1];
  for (let pass = 0; pass < 3; pass++) {
    const blurred = Array<number>(kernel.length + 2 * radius).fill(0);
    for (const [index, weight] of kernel.entries()) {
      for (let offset = 0; offset <= 2 * radius; offset++) blurred[index + offset]! += weight / (2 * radius + 1);
    }
    kernel = blurred;
  }
  return kernel;
}

export function panoramaBlurTaps(kernel: readonly number[]): [number, number][] {
  const half = (kernel.length - 1) / 2;
  const taps: [number, number][] = [];
  const groups = Math.min(5, kernel.length);
  for (let group = 0; group < groups; group++) {
    const start = Math.round(group * kernel.length / groups);
    const end = Math.round((group + 1) * kernel.length / groups);
    let weight = 0;
    let moment = 0;
    for (let index = start; index < end; index++) {
      weight += kernel[index]!;
      moment += (index - half) * kernel[index]!;
    }
    taps.push([moment / weight, weight]);
  }
  return taps;
}

export function tickSmoothedProgress(time: number, tickWeight: number, targetAt: (time: number) => number): number {
  let value = 0;
  const ticks = Math.floor(Math.max(0, time) * 20 + 1e-8);
  for (let tick = 1; tick <= ticks; tick++) value += tickWeight * (targetAt(tick / 20) - value);
  return value;
}
