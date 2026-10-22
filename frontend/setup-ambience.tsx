import { useEffect, useRef } from "react";

/* Three slow colour fields drawn on the GPU. Colour is computed in floating
   point and dithered per pixel before output; CSS gradients this faint
   quantise into visible rings on a dark background. */
const VERTEX = `attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}`;
const FRAGMENT = `precision highp float;
uniform vec2 size;
uniform float time;
vec3 field(vec2 p, vec2 c, vec2 r, vec3 colour) {
  vec2 d = (p - c) / r;
  return colour * exp(-dot(d, d) * 1.6);
}
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
void main() {
  float aspect = size.x / size.y;
  vec2 p = vec2(gl_FragCoord.x / size.y, 1. - gl_FragCoord.y / size.y);
  float t = time;
  vec3 colour = vec3(0.071);
  colour += field(p, vec2(aspect * (0.24 + 0.07 * sin(t * 0.13)), 0.22 + 0.08 * cos(t * 0.11)),
    vec2(0.62, 0.5), vec3(0.118, 0.843, 0.376) * 0.11);
  colour += field(p, vec2(aspect * (0.8 + 0.06 * cos(t * 0.09)), 0.55 + 0.1 * sin(t * 0.12)),
    vec2(0.58, 0.55), vec3(0.427, 0.247, 0.847) * 0.16);
  colour += field(p, vec2(aspect * (0.45 + 0.1 * sin(t * 0.07 + 1.)), 0.95 + 0.06 * cos(t * 0.1)),
    vec2(0.7, 0.42), vec3(0.118, 0.373, 0.82) * 0.14);
  // Triangular dither of one 8-bit step removes banding without visible grain.
  float n = hash(gl_FragCoord.xy + fract(t)) - hash(gl_FragCoord.yx + 7.31 + fract(t));
  gl_FragColor = vec4(colour + n / 255., 1.);
}`;

export function SetupAmbience({ still }: { still: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    const gl = element?.getContext("webgl", {
      alpha: false,
      antialias: false,
      powerPreference: "low-power",
    });
    if (!element || !gl) return;
    const shader = (type: number, source: string) => {
      const value = gl.createShader(type)!;
      gl.shaderSource(value, source);
      gl.compileShader(value);
      return value;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(program, "p");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const size = gl.getUniformLocation(program, "size");
    const time = gl.getUniformLocation(program, "time");
    // Start part-way through so the first frame is not symmetric.
    const start = performance.now() - 40_000;
    const draw = (now: number) => {
      const scale = window.devicePixelRatio || 1;
      const width = Math.round(element.clientWidth * scale),
        height = Math.round(element.clientHeight * scale);
      if (element.width !== width || element.height !== height) {
        element.width = width;
        element.height = height;
        gl.viewport(0, 0, width, height);
      }
      gl.uniform2f(size, width, height);
      gl.uniform1f(time, (now - start) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    element.dataset.ready = "true";
    let frame = 0,
      last = 0;
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      // Thirty frames a second is plenty for drift this slow.
      if (now - last < 33) return;
      last = now;
      draw(now);
    };
    let resize: ResizeObserver | undefined;
    if (still) {
      draw(performance.now());
      resize = new ResizeObserver(() => draw(performance.now()));
      resize.observe(element);
    } else frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      resize?.disconnect();
      delete element.dataset.ready;
    };
  }, [still]);
  return (
    <div className="setup-ambience" aria-hidden="true">
      <canvas ref={canvas} />
    </div>
  );
}
