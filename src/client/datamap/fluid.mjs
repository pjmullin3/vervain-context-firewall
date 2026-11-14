/* From the Vervain product codebase (pjmullin3/vervain ui/audit), pre-existing; see PROVENANCE.md. */
// Two-dimensional incompressible flow on a coarse collocated grid, after Stam, "Stable Fluids" (SIGGRAPH 1999).
// State: velocity u = (u, v) in world pixels per second, sampled at cell centres, with one ghost cell on each side.
// One step solves, in operator-split order,
//   du/dt = -(u.grad)u + nu lap u + f - lambda u,   div u = 0
// as: add impulses f (pointer splats) -> viscous diffusion (implicit, Jacobi) -> projection -> semi-Lagrangian advection
// -> projection -> exponential decay. The projection solves lap phi = div u* and sets u = u* - grad phi, where
// phi = (dt / rho) p, so the pressure is p = rho phi / dt. Density rho is 1 (it only scales the pressure readout).
// Grid spacing h is `cell` world pixels; gradient and divergence use central differences on the same stencil, so the
// discrete divergence of the projected field is the residual reported by `diagnostics()`. Boundaries are no-slip walls:
// ghost velocity cells mirror the wall-normal component to zero at the wall; phi has a zero-gradient (Neumann) wall.
// World space, not camera space: pan and zoom never touch this field.
export function createFluid({n = 48, cell = 60, originX = 0, originY = 0, nu = 900, iterations = 24, decay = 0.9, maxSpeed = 2600, order2 = false} = {}) {
  const N = n + 2, size = N * N, h = cell;
  const u = new Float32Array(size), v = new Float32Array(size), u0 = new Float32Array(size), v0 = new Float32Array(size), phi = new Float32Array(size), div = new Float32Array(size);
  const ix = (i, j) => i + N * j;
  let lastStepMs = 0, steps = 0, lastResidual = {max: 0, mean: 0};
  // Neumann for scalars (b = 0); wall-normal velocity mirrored (b = 1 for u, 2 for v) so the wall value interpolates to zero.
  function bounds(b, x) {
    for (let i = 1; i <= n; i++) {
      x[ix(0, i)] = b === 1 ? -x[ix(1, i)] : x[ix(1, i)]; x[ix(n + 1, i)] = b === 1 ? -x[ix(n, i)] : x[ix(n, i)];
      x[ix(i, 0)] = b === 2 ? -x[ix(i, 1)] : x[ix(i, 1)]; x[ix(i, n + 1)] = b === 2 ? -x[ix(i, n)] : x[ix(i, n)];
    }
    x[ix(0, 0)] = .5 * (x[ix(1, 0)] + x[ix(0, 1)]); x[ix(0, n + 1)] = .5 * (x[ix(1, n + 1)] + x[ix(0, n)]);
    x[ix(n + 1, 0)] = .5 * (x[ix(n, 0)] + x[ix(n + 1, 1)]); x[ix(n + 1, n + 1)] = .5 * (x[ix(n, n + 1)] + x[ix(n + 1, n)]);
  }
  // Solve (I - a lap) x = x0 (diffusion) or lap x = rhs (Poisson) by Jacobi, which converges for this diagonally dominant system.
  function jacobi(b, x, x0, a, c) {
    const tmp = new Float32Array(size);
    for (let k = 0; k < iterations; k++) {
      for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) tmp[ix(i, j)] = (x0[ix(i, j)] + a * (x[ix(i - 1, j)] + x[ix(i + 1, j)] + x[ix(i, j - 1)] + x[ix(i, j + 1)])) / c;
      x.set(tmp); bounds(b, x);
    }
  }
  function diffuse(dt) {
    const a = nu * dt / (h * h); // dimensionless diffusion number; implicit form is stable for any a
    u0.set(u); v0.set(v); jacobi(1, u, u0, a, 1 + 4 * a); jacobi(2, v, v0, a, 1 + 4 * a);
  }
  function project() {
    for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) { div[ix(i, j)] = -(h * h) * 0.5 * (u[ix(i + 1, j)] - u[ix(i - 1, j)] + v[ix(i, j + 1)] - v[ix(i, j - 1)]) / h; phi[ix(i, j)] = 0; }
    bounds(0, div); bounds(0, phi);
    jacobi(0, phi, div, 1, 4); // lap phi = div u*  with h folded into div; Jacobi stencil (sum neighbours - h^2 div)/4
    for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) { u[ix(i, j)] -= 0.5 * (phi[ix(i + 1, j)] - phi[ix(i - 1, j)]) / h; v[ix(i, j)] -= 0.5 * (phi[ix(i, j + 1)] - phi[ix(i, j - 1)]) / h; }
    bounds(1, u); bounds(2, v);
  }
  function lerp2(x, gi, gj) { // bilinear sample of a field at fractional grid coordinates
    const i0 = Math.floor(gi), j0 = Math.floor(gj), s1 = gi - i0, t1 = gj - j0, s0 = 1 - s1, t0 = 1 - t1;
    return s0 * (t0 * x[ix(i0, j0)] + t1 * x[ix(i0, j0 + 1)]) + s1 * (t0 * x[ix(i0 + 1, j0)] + t1 * x[ix(i0 + 1, j0 + 1)]);
  }
  const clampG = g => Math.max(0.5, Math.min(n + 0.5, g));
  // Semi-Lagrangian: trace each cell centre back along the flow and interpolate. Unconditionally stable; the bilinear
  // interpolation is numerically dissipative (energy never increases). The optional MacCormack correction
  // (Selle, Fedkiw et al. 2008) adds a forward-backward error estimate and is clamped to the local extrema.
  function advect(dt) {
    u0.set(u); v0.set(v);
    const k = dt / h;
    for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) {
      const gi = clampG(i - k * u0[ix(i, j)]), gj = clampG(j - k * v0[ix(i, j)]);
      u[ix(i, j)] = lerp2(u0, gi, gj); v[ix(i, j)] = lerp2(v0, gi, gj);
    }
    if (order2) {
      const uf = Float32Array.from(u), vf = Float32Array.from(v);
      for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) {
        const gi = clampG(i + k * uf[ix(i, j)]), gj = clampG(j + k * vf[ix(i, j)]);
        const eu = 0.5 * (u0[ix(i, j)] - lerp2(uf, gi, gj)), ev = 0.5 * (v0[ix(i, j)] - lerp2(vf, gi, gj));
        const bi = clampG(i - k * u0[ix(i, j)]), bj = clampG(j - k * v0[ix(i, j)]), i0 = Math.floor(bi), j0 = Math.floor(bj);
        let lo = Infinity, hi = -Infinity, lov = Infinity, hiv = -Infinity;
        for (const [a, b] of [[i0, j0], [i0 + 1, j0], [i0, j0 + 1], [i0 + 1, j0 + 1]]) { lo = Math.min(lo, u0[ix(a, b)]); hi = Math.max(hi, u0[ix(a, b)]); lov = Math.min(lov, v0[ix(a, b)]); hiv = Math.max(hiv, v0[ix(a, b)]); }
        u[ix(i, j)] = Math.max(lo, Math.min(hi, uf[ix(i, j)] + eu)); v[ix(i, j)] = Math.max(lov, Math.min(hiv, vf[ix(i, j)] + ev));
      }
    }
    bounds(1, u); bounds(2, v);
  }
  const toGrid = (x, y) => [(x - originX) / h + n / 2 + 0.5, (y - originY) / h + n / 2 + 0.5];
  return {
    n, cell, get nu() { return nu; }, set nu(x) { nu = x; },
    /** Bounded impulse from pointer motion: a Gaussian splat of velocity (px/s) with radius in world px. */
    splat(x, y, fx, fy, radius = 140, cap = maxSpeed) {
      const [gx, gy] = toGrid(x, y), r = radius / h, speed = Math.hypot(fx, fy);
      if (speed > cap) { fx *= cap / speed; fy *= cap / speed; }
      const i0 = Math.max(1, Math.floor(gx - r)), i1 = Math.min(n, Math.ceil(gx + r)), j0 = Math.max(1, Math.floor(gy - r)), j1 = Math.min(n, Math.ceil(gy + r));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const w = Math.exp(-((i - gx) ** 2 + (j - gy) ** 2) / (r * r * 0.5));
        u[ix(i, j)] += w * fx; v[ix(i, j)] += w * fy;
      }
    },
    /** Advance by dt seconds. Returns the kinetic energy after the step so callers can settle. */
    step(dt) {
      const t0 = performance.now();
      diffuse(dt); project(); advect(dt); project();
      const d = Math.exp(-decay * dt); let ke = 0, mx = 0, sum = 0;
      for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) {
        const k = ix(i, j); u[k] *= d; v[k] *= d; ke += 0.5 * (u[k] * u[k] + v[k] * v[k]);
        const dv = Math.abs(0.5 * (u[ix(i + 1, j)] - u[ix(i - 1, j)] + v[ix(i, j + 1)] - v[ix(i, j - 1)]) / h); mx = Math.max(mx, dv); sum += dv;
      }
      lastResidual = {max: mx, mean: sum / (n * n)}; lastStepMs = performance.now() - t0; steps++;
      return ke;
    },
    /** Velocity at a world point (px/s); zero outside the grid. */
    sample(x, y) {
      const [gx, gy] = toGrid(x, y);
      if (gx < 0.5 || gy < 0.5 || gx > n + 0.5 || gy > n + 0.5) return [0, 0];
      return [lerp2(u, gx, gy), lerp2(v, gx, gy)];
    },
    energy() { let ke = 0; for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) ke += 0.5 * (u[ix(i, j)] ** 2 + v[ix(i, j)] ** 2); return ke; },
    /** Divergence residual after the last projection (1/s), step cost and pressure scale. */
    diagnostics(dt = 1 / 120) { let pmax = 0; for (let k = 0; k < size; k++) pmax = Math.max(pmax, Math.abs(phi[k]) / dt); return {divergence: lastResidual, stepMs: lastStepMs, steps, pressureMax: pmax, cells: n * n}; },
    clear() { u.fill(0); v.fill(0); },
    fields: {u, v, phi},
  };
}

/**
 * Model A: the low-Reynolds-number limit. For slow drags Re = U l / nu is small, the advection term is negligible and the
 * steady Stokes response to a moving disc is instantaneous and linear. This closed-form field is a regularised Stokeslet
 * (Cortez 2001) with a compact Gaussian envelope: u(r) = v_drag * exp(-r^2 / (2 sigma^2)) * (1 + cos-aligned share).
 * It is not exactly divergence free (the envelope breaks it); its divergence is measured in tests against Model B.
 */
export function stokesletField(sources, sigma = 180) {
  return (x, y) => {
    let ux = 0, uy = 0;
    for (const s of sources) {
      const dx = x - s.x, dy = y - s.y, r2 = dx * dx + dy * dy, w = Math.exp(-r2 / (2 * sigma * sigma));
      if (w < 1e-4) continue;
      const r = Math.sqrt(r2) || 1, ex = dx / r, ey = dy / r, along = ex * s.vx + ey * s.vy;
      // isotropic part plus the Stokeslet's r r^T / r^2 term, which drags fluid ahead of and behind the disc
      ux += w * (0.6 * s.vx + 0.4 * along * ex); uy += w * (0.6 * s.vy + 0.4 * along * ey);
    }
    return [ux, uy];
  };
}
