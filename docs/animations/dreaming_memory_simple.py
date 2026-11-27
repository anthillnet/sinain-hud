"""
Dreaming Memory (simple) — non-technical cut for a general LinkedIn audience.

Pairs with docs/social/linkedin-dreaming-memory.md. No math, no sphere, no cosine.
The metaphor is a MEMORY CARD that updates over time: when new info replaces old,
the old card is moved to a "History" shelf and dimmed — never thrown away. Includes
the war story (an early version deleted it → a user needed it → so we keep it).

Render (1080p, 60fps):
    manim -qh --fps 60 docs/animations/dreaming_memory_simple.py DreamingMemorySimple

Requires: manim (Community Edition). No LaTeX needed (Text only).
"""

from manim import *
import numpy as np
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sinain_eye import make_sinain_eye  # shared logo geometry (single source of truth)

INK = WHITE
GREY = GREY_B
OLD = BLUE_B          # a fact that's about to be replaced
CURRENT = GREEN_C     # the current-state fact
PAST = GREY_C         # superseded-but-kept
WARN = RED_C          # the "deleted, and we needed it" moment
EYE = "#00FF88"       # sinain eye brand green (matches overlay EyeWidget)
CARD_FILL = "#16161e"


class DreamingMemorySimple(Scene):
    def construct(self):
        self.camera.background_color = "#0d0d12"
        cap = self.caption_area()

        # ====================================================================
        # BEAT -1 — the sinain eye draws itself in
        # ====================================================================
        eye = self.sinain_eye(R=1.25, color=EYE)
        ring, pupil, spikes = eye[0], eye[1], eye[2]
        self.play(Create(ring), run_time=1.0)
        self.play(DrawBorderThenFill(pupil), run_time=0.8)
        self.play(LaggedStart(*[GrowFromPoint(s, ORIGIN) for s in spikes],
                              lag_ratio=0.08), run_time=0.9)
        # a single ambient "pulse" — the eye is watching, alive
        self.play(pupil.animate.scale(1.18), rate_func=there_and_back, run_time=0.8)
        mark = Text("sinain", font_size=40, color=EYE).next_to(eye, DOWN, buff=0.5)
        self.play(FadeIn(mark, shift=UP * 0.15))
        self.wait(0.8)
        self.play(FadeOut(eye), FadeOut(mark))

        # ====================================================================
        # BEAT 0 — hook
        # ====================================================================
        hook = Text('OpenAI introduced "dreaming" this week.', font_size=40, color=INK)
        sub = Text("AI memory that updates as life moves on.",
                   font_size=28, color=GREY).next_to(hook, DOWN, buff=0.4)
        self.play(Write(hook), run_time=1.3)
        self.play(FadeIn(sub, shift=UP * 0.2))
        self.wait(1.3)
        self.play(FadeOut(hook), FadeOut(sub))

        # ====================================================================
        # BEAT 1 — the simple example (Singapore card updates)
        # ====================================================================
        self.set_caption(cap, "A simple example.")
        card = self.memory_card("You're going to\nSingapore in July", OLD).shift(UP * 0.6)
        self.play(FadeIn(card, shift=UP * 0.3))
        self.wait(0.6)

        passing = Text("…July comes and goes…", font_size=24, color=GREY).next_to(card, DOWN, buff=0.6)
        self.play(FadeIn(passing))
        self.wait(0.6)

        card2 = self.memory_card("You went to\nSingapore.", CURRENT).move_to(card)
        self.set_caption(cap, "Memory updates as things change.")
        self.play(FadeTransform(card, card2), FadeOut(passing))
        card = card2
        self.wait(1.0)
        self.play(FadeOut(card))

        # ====================================================================
        # BEAT 2 — people change (staccato, text only)
        # ====================================================================
        self.set_caption(cap, "Because people change.")
        lines = VGroup(
            Text("You change jobs.", font_size=34, color=INK),
            Text("You move.", font_size=34, color=INK),
            Text("Your priorities shift.", font_size=34, color=INK),
            Text("Projects start and finish.", font_size=34, color=INK),
        ).arrange(DOWN, buff=0.35, aligned_edge=LEFT)
        for ln in lines:
            self.play(FadeIn(ln, shift=RIGHT * 0.3), run_time=0.45)
        self.wait(0.6)
        stale = Text("Keep every fact forever → it goes stale.",
                     font_size=30, color=GREY).next_to(lines, DOWN, buff=0.5)
        self.play(FadeIn(stale))
        self.wait(1.0)
        self.play(FadeOut(lines), FadeOut(stale))

        # ====================================================================
        # BEAT 3 — our philosophy: current card + History shelf
        # ====================================================================
        self.set_caption(cap, "When new clearly replaces old —")

        # the History shelf
        shelf = Line(LEFT * 5.2, RIGHT * 5.2, color=GREY_D, stroke_width=2).to_edge(DOWN, buff=1.5)
        shelf_lbl = Text("History", font_size=22, color=GREY).next_to(shelf, UP, buff=0.1).to_edge(LEFT, buff=0.6)
        self.play(Create(shelf), FadeIn(shelf_lbl))

        old_card = self.memory_card("Going to\nSingapore", OLD).shift(UP * 1.3)
        self.play(FadeIn(old_card, shift=UP * 0.2))
        self.wait(0.4)

        # new current card appears
        new_card = self.memory_card("Went to\nSingapore", CURRENT).shift(UP * 1.3 + RIGHT * 0.0)
        cur_badge = self.badge("current", CURRENT)
        self.set_caption(cap, "mark the old as history — not current.")
        self.play(FadeTransform(old_card.copy(), new_card))
        cur_badge.next_to(new_card, UP, buff=0.15)
        self.play(FadeIn(cur_badge))

        # old card slides to the shelf, dims, gets a "past" badge.
        # NOTE: pre-style the target and use a SINGLE Transform — combining
        # Transform(old_card, ...) with old_card.animate.* in one play() makes
        # the two animations fight and the card never actually moves.
        old_small = old_card.copy().scale(0.7).set_color(PAST).set_opacity(0.55)
        old_small.next_to(shelf, UP, buff=0.15).shift(LEFT * 2.3)
        past_badge = self.badge("past", PAST).scale(0.7).next_to(old_small, RIGHT, buff=0.2)
        self.play(Transform(old_card, old_small))
        self.play(FadeIn(past_badge))
        self.wait(1.0)

        # ====================================================================
        # BEAT 4 — the war story (delete -> needed -> restore)
        # ====================================================================
        self.set_caption(cap, "We learned this the hard way.")
        early = Text("an early version", font_size=24, color=WARN).to_edge(UP).shift(DOWN * 0.1)
        self.play(FadeIn(early))

        # it DELETED the old memory: card vanishes, leaving a dashed ghost
        ghost = DashedVMobject(
            RoundedRectangle(corner_radius=0.12, width=old_card.width, height=old_card.height,
                             stroke_color=WARN, stroke_width=2),
            num_dashes=40,
        ).move_to(old_card)
        self.set_caption(cap, "It deleted outdated memories.")
        self.play(FadeOut(old_card, scale=0.2), FadeOut(past_badge), FadeIn(ghost))
        self.wait(0.5)

        # then a user needs it
        ask = Text('"…wait, what about that?"', font_size=30, color=INK).shift(DOWN * 0.15)
        qmark = Text("?", font_size=48, color=WARN).move_to(ghost)
        self.set_caption(cap, "A week later, it mattered again.")
        self.play(FadeIn(ask, shift=DOWN * 0.2), FadeIn(qmark))
        self.play(Indicate(ghost, color=WARN, scale_factor=1.1))
        self.wait(0.8)

        # so we changed it: the memory comes back, kept on the shelf
        restored = self.memory_card("Going to\nSingapore", PAST).scale(0.7).move_to(ghost)
        restored.set_opacity(0.6)
        kept_badge = self.badge("kept", PAST).scale(0.7).next_to(restored, RIGHT, buff=0.2)
        self.set_caption(cap, "So now — we don't erase the past.")
        self.play(FadeOut(ask), FadeOut(qmark), FadeOut(ghost),
                  FadeIn(restored), FadeIn(kept_badge), FadeOut(early))
        self.wait(1.0)

        # clear the stage for the principles
        self.play(*[FadeOut(m) for m in [shelf, shelf_lbl, new_card, cur_badge,
                                         restored, kept_badge]])

        # ====================================================================
        # BEAT 5 — three principles
        # ====================================================================
        self.set_caption(cap, "Our philosophy, in three lines.")
        p = VGroup(
            Text("→  Never deleted — just marked past", font_size=32, color=INK),
            Text("→  We can explain why it changed", font_size=32, color=INK),
            Text("→  Runs locally, on your machine", font_size=32, color=INK),
        ).arrange(DOWN, buff=0.45, aligned_edge=LEFT)
        for ln in p:
            self.play(FadeIn(ln, shift=RIGHT * 0.3), run_time=0.55)
        # tiny laptop next to the local line
        lap = self.laptop(GREEN_C).next_to(p[2], RIGHT, buff=0.4)
        self.play(FadeIn(lap))
        self.wait(1.4)
        self.play(FadeOut(p), FadeOut(lap), FadeOut(cap))

        # ====================================================================
        # BEAT 6 — tagline
        # ====================================================================
        small_eye = self.sinain_eye(R=0.55, color=EYE, stroke=4, spike_w=2.5)
        tag = Text("We dream — but we don't forget.", font_size=46, color=INK)
        sub2 = Text("ambient intelligence  ·  private  ·  yours",
                    font_size=28, color=GREY)
        sinain = Text("sinain", font_size=40, color=EYE)
        group = VGroup(small_eye, tag, sub2, sinain).arrange(DOWN, buff=0.45)
        self.play(FadeIn(small_eye, scale=0.85))   # bookend: the eye returns
        self.play(Write(tag))
        self.play(FadeIn(sub2, shift=UP * 0.2))
        self.play(FadeIn(sinain))
        self.wait(2.2)

    # ------------------------------------------------------------------ helpers
    def caption_area(self):
        return Text("", font_size=28, color=GREY).to_edge(DOWN, buff=0.55)

    def set_caption(self, cap, text):
        new = Text(text, font_size=28, color=GREY).to_edge(DOWN, buff=0.55)
        if cap.text == "":
            cap.become(new)
            self.play(FadeIn(cap, shift=UP * 0.15), run_time=0.5)
        else:
            self.play(Transform(cap, new), run_time=0.5)

    def memory_card(self, text, accent, w=4.6, h=1.6):
        box = RoundedRectangle(corner_radius=0.18, width=w, height=h,
                               stroke_color=accent, stroke_width=3,
                               fill_color=CARD_FILL, fill_opacity=1.0)
        txt = Text(text, font_size=28, color=INK, line_spacing=0.85)
        txt.move_to(box)
        return VGroup(box, txt)

    def badge(self, label, color):
        b = RoundedRectangle(corner_radius=0.12, width=1.6, height=0.55,
                             stroke_color=color, stroke_width=2,
                             fill_color=color, fill_opacity=0.15)
        t = Text(label, font_size=22, color=color).move_to(b)
        return VGroup(b, t)

    def laptop(self, color, s=0.6):
        screen = RoundedRectangle(corner_radius=0.05, width=0.9, height=0.6,
                                  stroke_color=color, stroke_width=3, fill_opacity=0)
        base = Polygon([-0.62, -0.32, 0], [0.62, -0.32, 0],
                       [0.48, -0.44, 0], [-0.48, -0.44, 0],
                       stroke_color=color, stroke_width=2,
                       fill_color=color, fill_opacity=0.2)
        return VGroup(screen, base).scale(s)

    def sinain_eye(self, R=1.25, color=EYE, stroke=8, spike_w=5):
        """Thin delegate to the shared builder in sinain_eye.py (single source of
        truth for the logo geometry)."""
        return make_sinain_eye(R=R, color=color, stroke=stroke, spike_w=spike_w)
