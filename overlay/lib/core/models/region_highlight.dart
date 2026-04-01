/// A screen region where sinain can help (Grammarly mode).
class RegionHighlight {
  final List<double> bbox; // [x, y, w, h] in screen coordinates
  final String issue;
  final String tip;
  final String? action; // fix, explain, research

  RegionHighlight({
    required this.bbox,
    required this.issue,
    required this.tip,
    this.action,
  });

  factory RegionHighlight.fromJson(Map<String, dynamic> json) {
    final rawBbox = json['bbox'] as List<dynamic>? ?? [0, 0, 0, 0];
    return RegionHighlight(
      bbox: rawBbox.map((e) => (e as num).toDouble()).toList(),
      issue: json['issue'] as String? ?? '',
      tip: json['tip'] as String? ?? '',
      action: json['action'] as String?,
    );
  }
}
