/// Actionable screen region detected by the agent (Grammarly mode).
///
/// Sent by sinain-core as a `region_highlight` message containing the full
/// current set; the overlay diffs by [id] (stable content hash — the same
/// issue re-detected later keeps its id, so eyes don't flicker).
class RegionHighlight {
  final String id;
  final String issue;
  final String tip;

  /// "fix" | "explain" | "research" (null when the LLM omitted it).
  final String? action;

  /// [x, y, w, h] in capture-frame pixels (null → no screen anchor; the
  /// overlay stacks anchorless eyes in a screen corner).
  final List<double>? bbox;

  /// [w, h] of the capture frame the bbox is expressed in.
  final List<double>? frameSize;

  const RegionHighlight({
    required this.id,
    required this.issue,
    required this.tip,
    this.action,
    this.bbox,
    this.frameSize,
  });

  factory RegionHighlight.fromJson(Map<String, dynamic> json) {
    List<double>? doubles(dynamic v, int len) {
      if (v is List && v.length == len && v.every((e) => e is num)) {
        return v.map((e) => (e as num).toDouble()).toList();
      }
      return null;
    }

    return RegionHighlight(
      id: json['id'] as String? ?? '',
      issue: json['issue'] as String? ?? '',
      tip: json['tip'] as String? ?? '',
      action: json['action'] as String?,
      bbox: doubles(json['bbox'], 4),
      frameSize: doubles(json['frameSize'], 2),
    );
  }
}
