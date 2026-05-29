/// SEED-001 Phase 5 — install tier model for the first-run wizard.
///
/// Three tiers select where models run. They share the same binaries and differ
/// only in which models run where. See docs/dmg-distribution-spec.md §1.
library;

/// The three install tiers offered by the first-run wizard.
enum InstallTier {
  /// Cloud-only (default). Analyzer + vision + transcription via OpenRouter.
  cloudOnly,

  /// Cloud + local Whisper. Audio transcription stays on-device.
  cloudPlusLocalWhisper,

  /// Full local / paranoid. Ollama analyzer + vision + whisper.cpp. Zero cloud.
  fullLocal,
}

/// Static, display-oriented metadata for each tier. The actual env-var mapping
/// this implies is written by the wizard's "write .env" step (SPEC §1) — kept
/// out of the overlay so the contract lives in one place (sinain-core / docs).
class InstallTierInfo {
  const InstallTierInfo({
    required this.tier,
    required this.shortName,
    required this.tagline,
    required this.cloudEgress,
    required this.approxDiskGb,
    required this.productizes,
  });

  final InstallTier tier;
  final String shortName;
  final String tagline;

  /// Plain-language description of what leaves the machine.
  final String cloudEgress;

  /// Rough additional disk footprint for downloaded models, in GB.
  final double approxDiskGb;

  /// The existing CLI flow this tier productizes (for maintainer reference).
  final String productizes;

  static const cloudOnly = InstallTierInfo(
    tier: InstallTier.cloudOnly,
    shortName: 'Cloud',
    tagline: 'Fastest setup. Uses OpenRouter for everything.',
    cloudEgress: 'Screen + audio context (redacted per privacy mode)',
    approxDiskGb: 0,
    productizes: './start.sh',
  );

  static const cloudPlusLocalWhisper = InstallTierInfo(
    tier: InstallTier.cloudPlusLocalWhisper,
    shortName: 'Hybrid',
    tagline: 'Audio transcribed on-device; analysis still in the cloud.',
    cloudEgress: 'Screen context only — audio never leaves your Mac',
    approxDiskGb: 1.6,
    productizes: './start-local.sh',
  );

  static const fullLocal = InstallTierInfo(
    tier: InstallTier.fullLocal,
    shortName: 'Private',
    tagline: 'Fully offline. Needs Ollama + ~9 GB of models.',
    cloudEgress: 'Nothing — zero cloud requests',
    approxDiskGb: 9.0,
    productizes: './start.sh --paranoid',
  );

  static const List<InstallTierInfo> all = [
    cloudOnly,
    cloudPlusLocalWhisper,
    fullLocal,
  ];
}
