import { createTomlAdapter } from './_toml-utils.mjs';

export default createTomlAdapter({
  name: 'kimicode',
  directory: '.kimicode',
  confidence: 'speculative',
  notes: 'KimiCode lifecycle hooks in config.toml.',
});
