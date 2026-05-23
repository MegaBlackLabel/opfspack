import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      external: ['comlink', 'fflate'],
    },
  },
  plugins: [
    dts({
      entryRoot: 'src',
      include: ['src'],
      rollupTypes: true,
      insertTypesEntry: true,
    }),
  ],
})
