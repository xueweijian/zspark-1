import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: { build: { outDir: 'out/main', lib: { entry: 'src/main/index.ts' } } },
  preload: { build: { outDir: 'out/preload', lib: { entry: 'src/preload/index.ts' } } },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: { outDir: 'out/renderer' }
  }
})
