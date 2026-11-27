"""
sinain eye — reusable logo asset for animations.

Faithful reproduction of docs/logo.svg: an outer ring, a vertical cat-slit pupil
(two quadratic Béziers), and 8 radial spikes at 45°. Brand green #00FF88 matches
the overlay's EyeWidget.

Two ways to use it:

1. As a building block in any scene:
       from sinain_eye import make_sinain_eye, draw_sinain_eye, EYE_GREEN
       eye = make_sinain_eye(R=1.25)        # static VGroup(ring, pupil, spikes)
       draw_sinain_eye(self, eye)           # animate it drawing itself in

2. As a standalone bumper / intro sting / end-card:
       manim -qh --fps 60 docs/animations/sinain_eye.py SinainEye
   Transparent version (alpha, for compositing over other footage):
       manim -qh --fps 60 --format=mov --transparent docs/animations/sinain_eye.py SinainEye

No LaTeX required (Text only).
"""

from manim import *
import numpy as np

EYE_GREEN = "#00FF88"   # sinain brand green (overlay EyeWidget eyeColor)
BG = "#0d0d12"


def make_sinain_eye(R=1.25, color=EYE_GREEN, stroke=8, spike_w=5):
    """Return a static VGroup(ring, pupil, spikes) centered at ORIGIN.

    R         — outer-ring radius in Manim units.
    color     — stroke/fill color for the whole mark.
    stroke    — ring stroke width.
    spike_w   — spike stroke width.
    Geometry is mapped 1:1 from docs/logo.svg (1024 viewbox, ring r=360).
    """
    f = R / 360.0  # SVG ring radius is 360 in a 1024 viewbox

    def P(x, y):  # SVG coords (y-down, origin 512,512) -> Manim (y-up, centered)
        return np.array([(x - 512) * f, -(y - 512) * f, 0.0])

    ring = Circle(radius=R, color=color, stroke_width=stroke)

    # cat-slit pupil: two quadratic Béziers (right bulge, then left), pointed cusps
    p_top, p_bot = P(512, 314), P(512, 710)
    c_r, c_l = P(576, 512), P(448, 512)

    def q2c(p0, c, p2):  # quadratic control -> two cubic handles
        return p0 + (2 / 3) * (c - p0), p2 + (2 / 3) * (c - p2)

    h1a, h2a = q2c(p_top, c_r, p_bot)
    h1b, h2b = q2c(p_bot, c_l, p_top)
    pupil = VMobject(stroke_width=0, fill_color=color, fill_opacity=1.0)
    pupil.start_new_path(p_top)
    pupil.add_cubic_bezier_curve_to(h1a, h2a, p_bot)
    pupil.add_cubic_bezier_curve_to(h1b, h2b, p_top)

    # 8 radial spikes at 45°, just outside the ring (SVG r 373 -> 453)
    spikes = VGroup()
    for k in range(8):
        a = np.deg2rad(45 * k)
        d = np.array([np.cos(a), np.sin(a), 0.0])
        spikes.add(Line(R * 1.036 * d, R * 1.258 * d, color=color, stroke_width=spike_w))

    return VGroup(ring, pupil, spikes)


def draw_sinain_eye(scene, eye, pulse=True, rt=1.0):
    """Animate the eye drawing itself in on `scene`: ring -> pupil -> radiating
    spikes -> one ambient pulse. `rt` scales all run-times. Returns the eye."""
    ring, pupil, spikes = eye[0], eye[1], eye[2]
    center = eye.get_center()
    scene.play(Create(ring), run_time=1.0 * rt)
    scene.play(DrawBorderThenFill(pupil), run_time=0.8 * rt)
    scene.play(LaggedStart(*[GrowFromPoint(s, center) for s in spikes],
                           lag_ratio=0.08), run_time=0.9 * rt)
    if pulse:
        scene.play(pupil.animate.scale(1.18), rate_func=there_and_back, run_time=0.8 * rt)
    return eye


class SinainEye(Scene):
    """Standalone logo reveal — drop-in intro sting / end-card."""

    def construct(self):
        self.camera.background_color = BG
        eye = make_sinain_eye(R=1.25)
        draw_sinain_eye(self, eye)
        mark = Text("sinain", font_size=40, color=EYE_GREEN).next_to(eye, DOWN, buff=0.5)
        self.play(FadeIn(mark, shift=UP * 0.15))
        # a second slow pulse so an end-card breathes while it holds
        self.play(eye[1].animate.scale(1.12), rate_func=there_and_back, run_time=1.0)
        self.wait(1.2)
        self.play(FadeOut(eye), FadeOut(mark))
