"""
sinain flow (UX redesign) — "how it works" walkthrough (16:9).

Six real product screenshots from the ROI → chat → agent → handoff flow, shown
one at a time, large and legible. Each carries its own baked-in caption, so the
scene adds no text of its own — it just slides through them. The horizontal
motion is the transition and carries the forward narrative; a fixed bottom dot
stepper (●●●●●●) tracks progress. Ends on the shared sinain-eye end-card
(imported from sinain_eye.py) so the whole piece is one render.

Source screenshots live in the v2 repo (already captioned):
    sinain-hud-2/docs/media/flow-demo-ux-redesign/flow-{1..6}.png

Render (16:9 1080p):
    manim -qh -r 1920,1080 --fps 30 docs/animations/sinain_flow_ux.py SinainFlowUX

No LaTeX required (Text only).
"""
import os, sys
from manim import *

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sinain_eye import make_sinain_eye, draw_sinain_eye, EYE_GREEN, BG

# Captioned source screenshots live in the v2 repo's docs/media.
SHOTS = os.environ.get(
    "SINAIN_FLOW_SRC",
    "/Users/Igor.Gerasimov/IdeaProjects/sinain-hud-2/docs/media/flow-demo-ux-redesign",
)

CARD_STROKE = "#2e3846"
DIM = "#3a4453"

# Step order matches the product flow. Accent tints the active stepper dot.
STEPS = [
    ("flow-1.png", "#58C4DD"),   # spot a ROI — Sinain highlights actionable regions
    ("flow-2.png", "#FFC45A"),   # engage via chat or agent
    ("flow-3.png", EYE_GREEN),   # chat opens with full situational context
    ("flow-4.png", "#78CDFF"),   # CLI agent opens preseeded with the same knowledge
    ("flow-5.png", "#C58AF9"),   # handoff the thread to any AI assistant
    ("flow-6.png", "#FF8A8A"),   # double-tap the eye to select a region manually
]

BOX_H = 7.05         # uniform screenshot height (units); width varies
IMG_Y = 0.28         # vertical center of the hero screenshot
DOT_Y = -3.84        # baseline for the bottom dot stepper


def make_card(filename):
    """Hero screenshot (fixed height) + thin rounded frame, grouped."""
    img = ImageMobject(os.path.join(SHOTS, filename)).set(height=BOX_H)
    frame = RoundedRectangle(
        corner_radius=0.12, width=img.width + 0.06, height=img.height + 0.06,
        stroke_color=CARD_STROKE, stroke_width=1.6, fill_opacity=0,
    ).move_to(img.get_center())
    return Group(img, frame)


class SinainFlowUX(Scene):
    def construct(self):
        self.camera.background_color = BG
        SPAN = config.frame_width + 0.6        # one full frame between cards
        N = len(STEPS)

        # ---- cards in a horizontal strip (card i at x = i*SPAN) ------------
        cards = []
        for i, (fn, _ac) in enumerate(STEPS):
            c = make_card(fn)
            c.move_to([i * SPAN, IMG_Y, 0])
            cards.append(c)
        strip = Group(*cards)

        # ---- fixed dot stepper centered along the bottom ------------------
        gap = 0.62
        x0 = -gap * (N - 1) / 2
        dots = []
        for i in range(N):
            d = Dot(radius=0.072, color=DIM).move_to([x0 + i * gap, DOT_Y, 0])
            dots.append(d)
        stepper = VGroup(*dots)

        def activate(i):
            ac = STEPS[i][1]
            return dots[i].animate.set_color(ac).scale(1.55)

        def deactivate(i):
            return dots[i].animate.set_color(DIM).scale(1 / 1.55)

        # ============ animate ==============================================
        self.play(FadeIn(stepper), run_time=0.5)
        self.play(FadeIn(cards[0], shift=UP * 0.12), activate(0), run_time=0.7)
        self.wait(1.5)

        for i in range(1, N):
            self.play(
                strip.animate.shift(LEFT * SPAN),          # slide to next card
                deactivate(i - 1), activate(i),
                run_time=0.9, rate_func=smooth)
            self.wait(1.5)

        # ---- dissolve into the eye end-card --------------------------------
        self.play(FadeOut(strip), FadeOut(stepper), run_time=0.8)

        eye = make_sinain_eye(R=1.15)
        draw_sinain_eye(self, eye)
        mark = Text("sinain", font_size=40, color=EYE_GREEN).next_to(
            eye, DOWN, buff=0.5)
        self.play(FadeIn(mark, shift=UP * 0.15))
        self.play(eye[1].animate.scale(1.12), rate_func=there_and_back,
                  run_time=1.0)
        self.wait(1.0)
        self.play(FadeOut(eye), FadeOut(mark), run_time=0.7)
