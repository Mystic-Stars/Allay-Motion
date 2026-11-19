export const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const JAVA_CHUNKS = /* glsl */ `
uniform float progress, opacity, side, target, gap, statusCount;
uniform vec3 palette[12];
varying vec2 vUv;
void main() {
  float stepSize = 2.0 + gap;
  vec2 pixel = floor(vec2(vUv.x, 1.0 - vUv.y) * (side * stepSize - gap));
  vec2 cell = floor(pixel / stepSize) - floor(side / 2.0);
  float ring = max(abs(cell.x), abs(cell.y));
  float delay = fract(sin(dot(cell, vec2(71.19, 27.17))) * 43758.54);
  float extra = max(0.0, ring - floor(target / 2.0)) / max(1.0, (side - target) / 2.0);
  float arrival = length(cell) / (side * 0.75) * 0.58 + delay * 0.10;
  float completion = clamp((progress - arrival) / 0.31, 0.0, 1.0);
  int status = int(floor(min(completion, 1.0 - extra * 0.42) * statusCount + 0.00001));
  vec3 color = vec3(0.0);
  if (status > 0 && all(lessThan(mod(pixel, stepSize), vec2(2.0)))) color = palette[status - 1];
  gl_FragColor = vec4(color, opacity);
}
`;
