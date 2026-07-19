import { createTomlAdapter } from './_toml-utils.mjs';

export default createTomlAdapter({
  name: 'kimi',
  directory: '.kimi',
  confidence: 'doc-derived',
  notes: 'Kimi lifecycle hooks in config.toml.',
});
