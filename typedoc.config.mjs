import { OptionDefaults } from 'typedoc';

export default {
  entryPoints: [
    'js/index.js',
    'js/categorias.js',
    'js/storage.js',
    'js/test_engine.js',
    'js/aplicar_flags.js',
    'scripts/aplicar_flags.js'
  ],
  tsconfig: 'tsconfig.json',
  out: 'docs',
  blockTags: [...OptionDefaults.blockTags, '@mermaid']
};
