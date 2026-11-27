"""
Dreaming Memory — change-point supersession, 3Blue1Brown style.

Companion animation for LinkedIn Post 1 ("we dream too — here's the difference").
Visualizes Chapter 3 of docs/lecture-memory-as-geometry.md: a fact's values over
time as arrows on the "sphere of meaning" (drawn in 2D for legibility), the
semantic JUMP that marks a change-point, and "supersede, not delete."

Design rule: ONE idea on screen at a time. Each beat clears the previous beat's
scaffolding (cosine readouts, angles, the rule) before the next begins, so the
frame stays calm even though the whole story has many parts.

Render (1080p, 60fps, good for LinkedIn):
    manim -qh --fps 60 docs/animations/dreaming_memory.py DreamingMemory

Requires: manim (Community Edition) + a LaTeX install (for MathTex). If LaTeX is
unavailable, swap the one MathTex call for Text — flagged inline.
"""

from manim import *
import numpy as np

# --- sinain palette -----------------------------------------------------------
STABLE = BLUE_B      # facts that haven't moved (the two Chicagos)
JUMP = YELLOW        # the change-point
CURRENT = GREEN_C    # the latest, current-state fact (suburbs)
PAST = GREY_B        # superseded-but-kept
INK = WHITE


class DreamingMemory(Scene):
    def construct(self):
        self.camera.background_color = "#0d0d12"

        center = LEFT * 3.0 + DOWN * 0.2
        R = 2.4

        def pt(angle_deg):
            a = np.deg2rad(angle_deg)
            return center + R * np.array([np.cos(a), np.sin(a), 0.0])

        # Cosines match the lecture: Jan->Mar 12deg (0.98), Mar->Jun 66deg (0.41)
        A_JAN, A_MAR, A_JUN = 80, 68, 2
        read_pos = center + RIGHT * 4.4 + UP * 0.4   # single readout anchor

        caption = self.caption_area()

        # ====================================================================
        # BEAT 0 — hook
        # ====================================================================
        hook = VGroup(
            Text("Memory that stays current.", font_size=44, color=INK),
            Text("OpenAI calls it dreaming.", font_size=30, color=GREY_A),
            Text("We built it too — here's the difference.", font_size=30, color=GREY_A),
        ).arrange(DOWN, buff=0.35)
        self.play(Write(hook[0]), run_time=1.2)
        self.play(FadeIn(hook[1], shift=UP * 0.2))
        self.play(FadeIn(hook[2], shift=UP * 0.2))
        self.wait(1.2)
        self.play(FadeOut(hook, shift=UP * 0.3))

        # ====================================================================
        # BEAT 1 — the picture (and then clear the scaffolding label)
        # ====================================================================
        circle = Circle(radius=R, color=GREY_C, stroke_width=2).move_to(center)
        sphere_lbl = Text("the sphere of meaning", font_size=22, color=GREY_A)
        sphere_lbl.next_to(circle, DOWN, buff=0.25)
        question = Text('"Where do you live?"', font_size=32, color=INK).to_edge(UP).shift(DOWN * 0.2)

        self.set_caption(caption, "One fact. Its value over time.")
        self.play(Create(circle), FadeIn(sphere_lbl), Write(question))
        self.wait(0.8)
        self.play(FadeOut(sphere_lbl))   # served its purpose — clear it

        # ====================================================================
        # BEAT 2 — two stable values
        # ====================================================================
        jan = self.value_arrow(center, pt(A_JAN), STABLE, "Chicago", "Jan", UL)
        self.play(GrowArrow(jan["arrow"]), FadeIn(jan["dot"]), Write(jan["label"]))
        self.wait(0.2)

        mar = self.value_arrow(center, pt(A_MAR), STABLE, "Chicago", "Mar", UR)
        self.play(GrowArrow(mar["arrow"]), FadeIn(mar["dot"]), Write(mar["label"]))

        ang1 = Angle(Line(center, pt(A_MAR)), Line(center, pt(A_JAN)),
                     radius=1.0, color=STABLE, stroke_width=3)
        cos1 = self.cos_readout(0.98, STABLE).move_to(read_pos)
        self.set_caption(caption, "Stays close. The truth is stable.")
        self.play(Create(ang1), FadeIn(cos1))
        self.wait(0.9)

        # ====================================================================
        # BEAT 3 — the jump (clear the 'stable' scaffolding first)
        # ====================================================================
        self.play(FadeOut(ang1), FadeOut(cos1))
        self.set_caption(caption, "Then the value jumps.")

        jun = self.value_arrow(center, pt(A_JUN), CURRENT, "the suburbs", "Jun", DR)
        self.play(GrowArrow(jun["arrow"]), FadeIn(jun["dot"]), Write(jun["label"]))

        ang2 = Angle(Line(center, pt(A_JUN)), Line(center, pt(A_MAR)),
                     radius=1.0, color=JUMP, stroke_width=5)
        cos2 = self.cos_readout(0.41, JUMP).move_to(read_pos)
        self.play(Create(ang2), FadeIn(cos2))
        self.play(Flash(pt((A_MAR + A_JUN) / 2), color=JUMP, flash_radius=0.6))
        self.wait(0.6)

        # one compact line instead of a multi-line formula
        # MathTex needs LaTeX; fallback: Text("below threshold -> change-point")
        cp = MathTex(r"0.41 < \delta \;\Rightarrow\; \text{change-point}",
                     font_size=34, color=INK).next_to(cos2, DOWN, buff=0.6)
        self.set_caption(caption, "A jump means the truth moved.")
        self.play(FadeIn(cp))
        self.wait(0.9)

        # ====================================================================
        # BEAT 4 — supersede, not delete  (clear ALL analysis clutter first)
        # ====================================================================
        self.play(FadeOut(ang2), FadeOut(cos2), FadeOut(cp))
        self.set_caption(caption, "Trust what came after the jump.")

        glow = Circle(radius=0.28, color=CURRENT, stroke_width=6).move_to(jun["dot"])
        current_tag = Text("current", font_size=24, color=CURRENT).next_to(jun["label"], DOWN, buff=0.12)
        self.play(
            jun["arrow"].animate.set_color(CURRENT).set_stroke(width=8),
            jun["dot"].animate.set_color(CURRENT),
            jun["label"].animate.set_color(CURRENT),
            Create(glow), FadeIn(current_tag),
        )
        self.wait(0.4)

        past_group = VGroup(jan["arrow"], jan["dot"], jan["label"],
                            mar["arrow"], mar["dot"], mar["label"])
        self.set_caption(caption, "Supersede — not delete.")
        self.play(past_group.animate.set_color(PAST).set_opacity(0.35))
        self.wait(0.9)

        # ====================================================================
        # BEAT 5 — two queries (proves nothing was lost)
        # ====================================================================
        q_now = Text('"Where do you live now?"', font_size=32, color=INK).to_edge(UP).shift(DOWN * 0.2)
        self.play(FadeTransform(question, q_now))
        question = q_now
        self.play(Indicate(VGroup(jun["dot"], jun["label"], glow), color=CURRENT, scale_factor=1.25))
        self.wait(0.5)

        q_spring = Text('"And where in spring?"', font_size=32, color=INK).to_edge(UP).shift(DOWN * 0.2)
        self.play(FadeTransform(question, q_spring))
        question = q_spring
        self.set_caption(caption, "Still there. We don't forget.")
        self.play(
            VGroup(mar["arrow"], mar["dot"], mar["label"]).animate.set_color(STABLE).set_opacity(1.0),
            Indicate(mar["dot"], color=STABLE, scale_factor=1.3),
        )
        self.wait(0.9)

        # ====================================================================
        # BEAT 6 — tagline
        # ====================================================================
        self.play(
            *[FadeOut(m) for m in [circle, question, caption, glow, current_tag,
                                   jan["arrow"], jan["dot"], jan["label"],
                                   mar["arrow"], mar["dot"], mar["label"],
                                   jun["arrow"], jun["dot"], jun["label"]]]
        )
        tag = Text("We dream — but we don't forget.", font_size=46, color=INK)
        sub = Text("deterministic  ·  reversible  ·  on your machine",
                   font_size=28, color=GREY_A).next_to(tag, DOWN, buff=0.45)
        sinain = Text("sinain", font_size=40, color=CURRENT).next_to(sub, DOWN, buff=0.6)
        self.play(Write(tag))
        self.play(FadeIn(sub, shift=UP * 0.2))
        self.play(FadeIn(sinain))
        self.wait(2.0)

    # ------------------------------------------------------------------ helpers
    def caption_area(self):
        cap = Text("", font_size=28, color=GREY_A)
        cap.to_edge(DOWN, buff=0.55)
        return cap

    def set_caption(self, cap, text):
        new = Text(text, font_size=28, color=GREY_A).to_edge(DOWN, buff=0.55)
        if cap.text == "":
            cap.become(new)
            self.play(FadeIn(cap, shift=UP * 0.15), run_time=0.5)
        else:
            self.play(Transform(cap, new), run_time=0.5)

    def value_arrow(self, center, tip, color, name, when, label_dir):
        arrow = Arrow(center, tip, buff=0, color=color, stroke_width=6,
                      max_tip_length_to_length_ratio=0.12)
        dot = Dot(tip, color=color, radius=0.09)
        label = VGroup(
            Text(name, font_size=26, color=color),
            Text(when, font_size=18, color=GREY_A),
        ).arrange(DOWN, buff=0.05).next_to(tip, label_dir, buff=0.18)
        return {"arrow": arrow, "dot": dot, "label": label}

    def cos_readout(self, value, color):
        return VGroup(
            Text("cos =", font_size=30, color=GREY_A),
            Text(f"{value:.2f}", font_size=40, color=color, weight=BOLD),
        ).arrange(RIGHT, buff=0.18)
