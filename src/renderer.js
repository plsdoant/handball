// WebGL2 renderer for the metallic balls. Each ball is a screen-aligned quad shaded as a
// minimal sphere impostor: a soft lit gradient, one highlight and a faint rim.

const VS = `#version 300 es
in vec2 aCorner;
uniform vec2 uRes;
uniform vec2 uCenter;
uniform float uRadius;
out vec2 vLocal;
void main() {
  float ext = uRadius + 2.0;
  vec2 px = uCenter + aCorner * ext;
  vLocal = aCorner * ext / uRadius;
  vec2 clip = px / uRes * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec2 vLocal;
out vec4 outColor;
uniform float uRadius;
uniform float uAlpha;

void main() {
  float r = length(vLocal);
  float aa = 1.2 / uRadius;
  float cov = 1.0 - smoothstep(1.0 - aa, 1.0 + aa * 0.25, r);
  if (cov <= 0.001) discard;

  vec2 l = vLocal / max(r, 1.0);
  float z = sqrt(max(1.0 - dot(l, l), 0.0));
  vec3 N = vec3(l.x, -l.y, z);
  vec3 L = normalize(vec3(-0.45, 0.6, 0.66));
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));

  // Soft top-lit gradient, one highlight and a faint rim: reads as steel without scenery.
  float t = clamp(dot(N, L) * 0.65 + N.y * 0.2 + 0.22, 0.0, 1.0);
  vec3 col = mix(vec3(0.2, 0.21, 0.24), vec3(0.8, 0.82, 0.85), t);
  col += vec3(1.0) * pow(max(dot(N, H), 0.0), 70.0) * 0.55;
  col += vec3(0.85, 0.9, 1.0) * pow(1.0 - z, 3.0) * 0.12;

  float a = cov * uAlpha;
  outColor = vec4(col * a, a);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export class BallRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.u = {};
    for (const name of ['uRes', 'uCenter', 'uRadius', 'uAlpha']) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aCorner');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.w = 1;
    this.h = 1;
  }

  resize(w, h, dpr) {
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  render(balls) {
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!balls.length) return;

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform2f(this.u.uRes, this.w, this.h);

    for (const b of balls) {
      gl.uniform2f(this.u.uCenter, b.x, b.y);
      gl.uniform1f(this.u.uRadius, b.drawRadius);
      gl.uniform1f(this.u.uAlpha, b.alpha);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindVertexArray(null);
  }
}
