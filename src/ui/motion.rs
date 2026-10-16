//! Animation primitives used by the lyrics renderer.
//!
//! `Spring` is a Rust port of Fraktality's `spr` analytic spring (MIT), as
//! used by Spicy Lyrics. `Curve` is a natural cubic spline through key points,
//! matching the `cubic-spline` package Spicy Lyrics uses for word animation.

use std::f32::consts::TAU;

#[derive(Clone, Copy, Debug)]
pub struct Spring {
    pub position: f32,
    pub velocity: f32,
    pub goal: f32,
    /// Undamped frequency in hertz.
    pub frequency: f32,
    pub damping: f32,
}

impl Spring {
    pub fn new(position: f32, frequency: f32, damping: f32) -> Self {
        Self {
            position,
            velocity: 0.0,
            goal: position,
            frequency,
            damping,
        }
    }

    pub fn snap(&mut self, goal: f32) {
        self.goal = goal;
        self.position = goal;
        self.velocity = 0.0;
    }

    pub fn settled(&self) -> bool {
        let offset = self.position - self.goal;
        self.velocity * self.velocity <= 1e-4 && offset * offset <= (1.0 / 3840.0_f32).powi(2)
    }

    /// Advance by `dt` seconds using the closed-form solution, so large or
    /// irregular frame times stay stable.
    pub fn step(&mut self, dt: f32) -> f32 {
        let d = self.damping;
        let f = self.frequency * TAU;
        let g = self.goal;
        let p = self.position;
        let v = self.velocity;
        let offset = p - g;
        let (position, velocity) = if (d - 1.0).abs() < f32::EPSILON {
            let q = (-f * dt).exp();
            let w = dt * q;
            let c0 = q + w * f;
            let c2 = q - w * f;
            let c3 = w * f * f;
            (offset * c0 + v * w + g, v * c2 - offset * c3)
        } else if d < 1.0 {
            let q = (-d * f * dt).exp();
            let c = (1.0 - d * d).sqrt();
            let i = (dt * f * c).cos();
            let j = (dt * f * c).sin();
            let z = if c > 1e-5 { j / c } else { dt * f };
            let y = if f * c > 1e-5 { j / (f * c) } else { dt };
            (
                (offset * (i + z * d) + v * y) * q + g,
                (v * (i - z * d) - offset * (z * f)) * q,
            )
        } else {
            let c = (d * d - 1.0).sqrt();
            let r1 = -f * (d + c);
            let r2 = -f * (d - c);
            let e1 = (r1 * dt).exp();
            let e2 = (r2 * dt).exp();
            let co2 = (v - offset * r1) / (2.0 * f * c);
            let co1 = e1 * (offset - co2);
            (co1 + co2 * e2 + g, co1 * r1 + co2 * e2 * r2)
        };
        self.position = position;
        self.velocity = velocity;
        position
    }
}

/// Natural cubic spline through `(time, value)` points; input is clamped to
/// the first and last time.
pub struct Curve {
    times: Vec<f32>,
    values: Vec<f32>,
    second: Vec<f32>,
}

impl Curve {
    pub fn new(points: &[(f32, f32)]) -> Self {
        let times: Vec<f32> = points.iter().map(|point| point.0).collect();
        let values: Vec<f32> = points.iter().map(|point| point.1).collect();
        let n = points.len();
        let mut second = vec![0.0; n];
        if n > 2 {
            // Tridiagonal solve for second derivatives with natural ends.
            let mut upper = vec![0.0; n];
            let mut rhs = vec![0.0; n];
            for i in 1..n - 1 {
                let h0 = times[i] - times[i - 1];
                let h1 = times[i + 1] - times[i];
                let slope = (values[i + 1] - values[i]) / h1 - (values[i] - values[i - 1]) / h0;
                let diagonal = 2.0 * (h0 + h1) - h0 * upper[i - 1];
                upper[i] = h1 / diagonal;
                rhs[i] = (6.0 * slope - h0 * rhs[i - 1]) / diagonal;
            }
            for i in (1..n - 1).rev() {
                second[i] = rhs[i] - upper[i] * second[i + 1];
            }
        }
        Self {
            times,
            values,
            second,
        }
    }

    pub fn at(&self, t: f32) -> f32 {
        let n = self.times.len();
        match n {
            0 => return 0.0,
            1 => return self.values[0],
            _ => {}
        }
        let t = t.clamp(self.times[0], self.times[n - 1]);
        let i = self.times[1..n - 1]
            .iter()
            .position(|time| t < *time)
            .unwrap_or(n - 2);
        let h = self.times[i + 1] - self.times[i];
        let a = (self.times[i + 1] - t) / h;
        let b = (t - self.times[i]) / h;
        a * self.values[i]
            + b * self.values[i + 1]
            + ((a * a * a - a) * self.second[i] + (b * b * b - b) * self.second[i + 1]) * h * h
                / 6.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn critically_damped_spring_converges_without_overshoot() {
        let mut spring = Spring::new(0.0, 1.0, 1.0);
        spring.goal = 100.0;
        let mut previous = 0.0;
        for _ in 0..240 {
            let position = spring.step(1.0 / 60.0);
            assert!(position >= previous - 1e-3 && position <= 100.0 + 1e-3);
            previous = position;
        }
        assert!((spring.position - 100.0).abs() < 0.5);
    }

    #[test]
    fn spring_is_frame_rate_independent() {
        let mut fast = Spring::new(0.0, 1.45, 0.4);
        let mut slow = fast;
        fast.goal = 1.0;
        slow.goal = 1.0;
        for _ in 0..120 {
            fast.step(1.0 / 120.0);
        }
        for _ in 0..30 {
            slow.step(1.0 / 30.0);
        }
        assert!((fast.position - slow.position).abs() < 1e-3);
    }

    #[test]
    fn curve_passes_through_points_and_clamps() {
        let curve = Curve::new(&[(0.0, 0.95), (0.7, 1.0505), (1.0, 1.0)]);
        assert!((curve.at(0.0) - 0.95).abs() < 1e-5);
        assert!((curve.at(0.7) - 1.0505).abs() < 1e-5);
        assert!((curve.at(1.0) - 1.0).abs() < 1e-5);
        assert!((curve.at(2.0) - 1.0).abs() < 1e-5);
        assert!(curve.at(0.35) > 0.95 && curve.at(0.35) < 1.06);
    }
}
