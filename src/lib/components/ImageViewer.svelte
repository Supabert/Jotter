<script lang="ts">
  import { onMount } from 'svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { listen } from '@tauri-apps/api/event';
  import { resolveImageSrc } from '../api';
  import { store } from '../store.svelte';

  let src = $state('');
  /** Fit to the window, or the picture at its own pixel size. Click toggles. */
  let actual = $state(false);
  const win = getCurrentWindow();

  async function show(file: string) {
    actual = false;
    src = await resolveImageSrc(file);
  }

  onMount(() => {
    void store.loadTheme();
    const first = (window as unknown as { __jotterImage?: string }).__jotterImage;
    if (first) void show(first);

    const media = window.matchMedia('(prefers-color-scheme: light)');
    const onScheme = () => store.theme === 'system' && store.applyTheme();
    media.addEventListener('change', onScheme);

    const unShow = listen<string>('viewer:show', (e) => {
      void store.loadTheme();
      void show(e.payload);
    });

    return () => {
      media.removeEventListener('change', onScheme);
      unShow.then((f) => f());
    };
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      void win.close();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="viewer scroll" class:actual>
  {#if src}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <img {src} alt="" onclick={() => (actual = !actual)} />
  {/if}
</div>

<style>
  .viewer {
    height: 100vh;
    display: grid;
    place-items: center;
    background: var(--panel-0);
    overflow: auto;
  }

  img {
    max-width: 100%;
    max-height: 100vh;
    cursor: zoom-in;
  }

  .actual {
    place-items: start;
  }

  .actual img {
    max-width: none;
    max-height: none;
    cursor: zoom-out;
  }
</style>
