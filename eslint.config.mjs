import antfu from '@antfu/eslint-config'

export default antfu({
  typescript: true,
  formatters: true,
  stylistic: {
    indent: 2,
    quotes: 'single',
  },
  ignores: [
    'dist',
    'node_modules',
    'skills',
  ],
})
