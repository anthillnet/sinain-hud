import 'package:flutter_test/flutter_test.dart';
import 'package:sinain_hud/ui/regions/region_eye_controller.dart';

void main() {
  group('resolveEyeCollision', () {
    const screenH = 900.0;

    test('non-colliding position is unchanged', () {
      final pos = resolveEyeCollision(
          const Offset(100, 100), [const Offset(300, 300)], screenH);
      expect(pos, const Offset(100, 100));
    });

    test('same-position eye shifts down by one slot', () {
      final pos = resolveEyeCollision(
          const Offset(100, 100), [const Offset(100, 100)], screenH);
      expect(pos.dx, 100);
      expect(pos.dy, 100 + 48 + 8);
    });

    test('three co-located eyes stack without overlap', () {
      final placed = <Offset>[];
      for (var i = 0; i < 3; i++) {
        placed.add(
            resolveEyeCollision(const Offset(100, 100), placed, screenH));
      }
      // All pairwise distances ≥ eyeSize on at least one axis
      for (var i = 0; i < placed.length; i++) {
        for (var j = i + 1; j < placed.length; j++) {
          final dx = (placed[i].dx - placed[j].dx).abs();
          final dy = (placed[i].dy - placed[j].dy).abs();
          expect(dx >= 48 || dy >= 48, isTrue,
              reason: 'eyes $i and $j overlap: ${placed[i]} vs ${placed[j]}');
        }
      }
    });

    test('wraps to the top edge at the bottom of the screen', () {
      const bottom = Offset(100, screenH - 48 - 8);
      final pos = resolveEyeCollision(bottom, [bottom], screenH);
      expect(pos.dy, 8.0);
    });

    test('terminates on a saturated column (accepts overlap)', () {
      // Fill the whole column so no free slot exists
      final placed = [
        for (var y = 8.0; y < screenH; y += 20) Offset(100, y),
      ];
      final pos = resolveEyeCollision(const Offset(100, 100), placed, screenH);
      expect(pos.dx, 100); // returned something on the same column — no hang
    });
  });
}
