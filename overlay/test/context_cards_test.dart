import 'package:flutter_test/flutter_test.dart';
import 'package:sinain_hud/core/models/context_cards.dart';

void main() {
  test('SessionChipState parses agent attachment fields', () {
    final chip = SessionChipState.fromJson({
      'sessionId': 'session-1',
      'threadId': 'thread-1',
      'status': 'paused',
      'label': 'Release',
      'startedTs': 100,
      'activeMs': 200,
      'agentsWorking': 2,
    });

    expect(chip.threadId, 'thread-1');
    expect(chip.agentsWorking, 2);
  });
}
