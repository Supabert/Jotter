import { mount } from 'svelte';
import { getCurrentWindow } from '@tauri-apps/api/window';
import './lib/design/tokens.css';
import './lib/design/panel.css';
import App from './App.svelte';
import Capture from './lib/components/Capture.svelte';

// Dev-only test surface. `import.meta.env.DEV` is a compile-time constant, so
// this block and everything it references are dropped from the release bundle
// rather than shipped behind a runtime check.
if (import.meta.env.DEV) {
  void (async () => {
    const [{ api }, { store }, { wrapSelectionAsAction }, { sanitizeHtml }, { invoke }, scale] =
      await Promise.all([
        import('./lib/api'),
        import('./lib/store.svelte'),
        import('./lib/editor/commands'),
        import('./lib/editor/sanitize'),
        import('@tauri-apps/api/core'),
        import('./lib/timeline/scale')
      ]);
    Object.assign(window, {
      __jotter: { api, store, wrapSelectionAsAction, sanitizeHtml, invoke },
      __jotterScale: scale
    });
  })();
}

// One bundle serves both windows; the label decides which one this is. Keeping
// them in one build means the capture window inherits the same design system
// and costs no second asset load.
const isCapture = getCurrentWindow().label === 'capture';

mount(isCapture ? Capture : App, { target: document.getElementById('app')! });
