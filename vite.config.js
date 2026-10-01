import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function manualChunks(id) {
  if (!id.includes('node_modules') && !id.includes(`${resolve(__dirname, 'src')}\\drawnix`) && !id.includes(`${resolve(__dirname, 'src')}/drawnix`)) {
    return undefined;
  }

  const normalizedId = id.replaceAll('\\', '/');

  if (normalizedId.includes('/node_modules/react/') || normalizedId.includes('/node_modules/react-dom/')) {
    return 'react-vendor';
  }

  if (normalizedId.includes('/node_modules/pdfjs-dist/')) {
    return 'pdf-vendor';
  }

  if (normalizedId.includes('/node_modules/epubjs/')) {
    return 'epub-vendor';
  }

  if (normalizedId.includes('/node_modules/uuid/')) {
    return 'uuid-vendor';
  }

  if (normalizedId.includes('/node_modules/marked/') || normalizedId.includes('/node_modules/katex/')) {
    return 'text-vendor';
  }

  if (
    normalizedId.includes('/node_modules/@plait/') ||
    normalizedId.includes('/src/drawnix/react-board/') ||
    normalizedId.includes('/src/drawnix/react-text/')
  ) {
    return 'plait-vendor';
  }

  if (
    normalizedId.includes('/src/drawnix/drawnix/') ||
    normalizedId.includes('/node_modules/@plait-board/')
  ) {
    return 'drawnix-vendor';
  }

  if (normalizedId.includes('/node_modules/elkjs/')) {
    return 'elk-vendor';
  }

  if (
    normalizedId.includes('/node_modules/mermaid/') ||
    normalizedId.includes('/node_modules/d3-') ||
    normalizedId.includes('/node_modules/dagre-') ||
    normalizedId.includes('/node_modules/cytoscape') ||
    normalizedId.includes('/node_modules/khroma/') ||
    normalizedId.includes('/node_modules/layout-base/') ||
    normalizedId.includes('/node_modules/graphlib/') ||
    normalizedId.includes('/node_modules/lodash-es/') ||
    normalizedId.includes('/node_modules/dayjs/')
  ) {
    return 'mermaid-vendor';
  }

  if (
    normalizedId.includes('mindmap-definition') ||
    normalizedId.includes('mermaid')
  ) {
    return 'diagram-vendor';
  }

  return undefined;
}

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1'
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@drawnix/drawnix': resolve(__dirname, './src/drawnix/drawnix/src'),
      '@plait-board/react-board': resolve(__dirname, './src/drawnix/react-board/src'),
      '@plait-board/react-text': resolve(__dirname, './src/drawnix/react-text/src'),
      'is-hotkey': resolve(__dirname, './src/vendor/is-hotkey-compat.js'),
    }
  },
  build: {
    target: 'es2020',
    minify: true,
    cssMinify: false,
    rollupOptions: {
      output: {
        manualChunks
      }
    }
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler', // or 'modern'
        silenceDeprecations: ['legacy-js-api', 'import', 'global-builtin'],
        includePaths: [resolve(__dirname, 'node_modules')]
      }
    }
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './test/setup.ts',
    exclude: ['node_modules', 'dist', 'drawnix-repo', 'src/drawnix'],
  }
});
