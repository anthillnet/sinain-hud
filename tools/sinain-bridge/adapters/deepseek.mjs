import { createTomlAdapter } from './_toml-utils.mjs';

export default createTomlAdapter({
  name: 'deepseek',
  directory: '.deepseek',
  confidence: 'doc-derived',
  notes: 'DeepSeek/CodeWhale lifecycle hooks in config.toml.',
});
