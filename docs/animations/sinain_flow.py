"""
sinain flow — "how it works" walkthrough (16:9).

Four real product screenshots, shown one at a time, large and legible. Each
slides in from the right as the previous slides out — the horizontal motion
is the transition and carries the forward narrative. A fixed bottom stepper
(1 -> 2 -> 3 -> 4) tracks progress. Ends on the shared sinain-eye end-card
(imported from sinain_eye.py) so the whole piece is one render.

Render (16:9 720p):
    manim -qh -r 1280,720 --fps 30 docs/animations/sinain_flow.py SinainFlow

No LaTeX required (Text only).
"""
import os, sys
from manim import *

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sinain_eye import make_sinain_eye, draw_sinain_eye, EYE_GREEN, BG

SHOTS = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "..", "media", "images", "screens"))

FONT = "Helvetica Neue"
CARD_STROKE = "#2e3846"
TXT = "#E9EFF8"
DIM = "#7C899B"
BLUE, AMBER, CYAN, GREEN = "#58C4DD", "#FFC45A", "#78CDFF", EYE_GREEN

STEPS = [
    ("enable-see-automatic-roi.png", BLUE,  "Sinain sees where AI can help"),
    ("chose-screen-area.png",        AMBER, "…or you point it at an area on your screen"),
    ("select-chat-or-agent.png",     CYAN,  "Pick your agent"),
    ("get-your-agent-working.png",   GREEN, "It works — knowing your whole context"),
]

BOX_H = 4.8          # uniform screenshot height (units); width varies
LABEL_Y = -2.85      # fixed baseline for the big step label
IMG_Y = 0.45         # vertical center of the hero screenshot


def make_card(filename, label):
    """Hero screenshot (fixed height) + rounded frame + big label, grouped."""
    img = ImageMobject(os.path.join(SHOTS, filename)).set(height=BOX_H)
    frame = RoundedRectangle(
        corner_radius=0.12, width=img.width + 0.10, height=img.height + 0.10,
        stroke_color=CARD_STROKE, stroke_width=1.8, fill_opacity=0,
    ).move_to(img.get_center())
    lbl = Text(label, font=FONT, font_size=34, color=TXT, weight=MEDIUM)
    if lbl.width > config.frame_width - 1.2:          # clamp long lines
        lbl.set(width=config.frame_width - 1.2)
    card = Group(img, frame, lbl)
    return card, lbl


class SinainFlow(Scene):
    def construct(self):
        self.camera.background_color = BG
        SPAN = config.frame_width + 0.6        # one full frame between cards

        # ---- fixed header --------------------------------------------------
        brand = VGroup(
            Dot(radius=0.09, color=BLUE),
            Text("SINAIN", font=FONT, font_size=30, color=TXT, weight=MEDIUM),
        ).arrange(RIGHT, buff=0.18).to_corner(UL, buff=0.55)

        title = Text("One glance  →  a working agent",
                     font=FONT, font_size=40, color=TXT, weight=MEDIUM)
        title.to_edge(UP, buff=0.5)

        # ---- cards in a horizontal strip (card i at x = i*SPAN) ------------
        cards, labels = [], []
        for fn, ac, lb in STEPS:
            c, l = make_card(fn, lb)
            cards.append(c); labels.append(l)
        for i, c in enumerate(cards):
            img = c[0]
            img.move_to([i * SPAN, IMG_Y, 0])
            c[1].move_to(img.get_center())                 # frame
            labels[i].move_to([i * SPAN, LABEL_Y, 0])      # label fixed baseline
        strip = Group(*cards)

        # ---- fixed stepper: (1)->(2)->(3)->(4) ----------------------------
        nodes, num_txt = [], []
        xs = [-4.0, -1.35, 1.35, 4.0]
        for i, x in enumerate(xs):
            circ = Circle(radius=0.30, stroke_color=DIM, stroke_width=3.5,
                          fill_color=BG, fill_opacity=1.0).move_to([x, -3.68, 0])
            t = Text(str(i + 1), font=FONT, font_size=24, color=DIM,
                     weight=BOLD).move_to(circ.get_center())
            nodes.append(circ); num_txt.append(t)
        connectors = VGroup(*[
            Arrow(nodes[i].get_right(), nodes[i + 1].get_left(),
                  buff=0.12, color=CARD_STROKE, stroke_width=4,
                  max_tip_length_to_length_ratio=0.18, tip_length=0.16)
            for i in range(3)])
        stepper = VGroup(connectors, *nodes, *num_txt)

        def activate(i):
            ac = STEPS[i][1]
            return AnimationGroup(
                nodes[i].animate.set_stroke(ac, width=4).set_fill(ac, opacity=1.0),
                num_txt[i].animate.set_color(BG),
            )
        def deactivate(i):
            return AnimationGroup(
                nodes[i].animate.set_stroke(DIM, width=3.5).set_fill(BG, opacity=1.0),
                num_txt[i].animate.set_color(DIM),
            )

        # ============ animate ==============================================
        self.play(FadeIn(brand, shift=DOWN * 0.15),
                  FadeIn(title, shift=DOWN * 0.15),
                  FadeIn(stepper), run_time=0.8)
        self.play(FadeIn(cards[0], shift=UP * 0.15), activate(0), run_time=0.7)
        self.wait(1.25)

        for i in range(1, 4):
            self.play(
                strip.animate.shift(LEFT * SPAN),          # slide to next card
                deactivate(i - 1), activate(i),
                run_time=0.9, rate_func=smooth)
            self.wait(1.25)

        # ---- dissolve into the eye end-card --------------------------------
        self.play(FadeOut(strip), FadeOut(brand), FadeOut(title),
                  FadeOut(stepper), run_time=0.8)

        eye = make_sinain_eye(R=1.15)
        draw_sinain_eye(self, eye)
        mark = Text("sinain", font_size=40, color=EYE_GREEN).next_to(
            eye, DOWN, buff=0.5)
        self.play(FadeIn(mark, shift=UP * 0.15))
        self.play(eye[1].animate.scale(1.12), rate_func=there_and_back,
                  run_time=1.0)
        self.wait(1.0)
        self.play(FadeOut(eye), FadeOut(mark), run_time=0.7)
