import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import tailwindCombiner from '../vitePluginTailwindCombiner.js'

export default defineConfig({
  plugins: [
    tailwindcss(),
    tailwindCombiner({
      minLength: 4,
      minOccurrences: 5,
    }),
  ],
})
