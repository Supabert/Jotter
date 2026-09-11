<script lang="ts">
  import { FONT_SIZES } from '../editor/commands';
  import { store } from '../store.svelte';

  interface Props {
    marks: Record<string, boolean>;
    size: number;
    labelId: number | null;
    pinned: boolean;
    archived: boolean;
    cmd: (id: string, value?: string) => void;
  }

  let { marks, size, labelId, pinned, archived, cmd }: Props = $props();

  let inkOpen = $state(false);
  let markerOpen = $state(false);
  let labelOpen = $state(false);

  /* Text colour is not free-for-all: these are the panel's own annunciator
     hues plus two neutrals, so a coloured word still reads as part of the
     instrument rather than as a sticker. The custom well is there for the
     once-a-year exception. */
  const INKS = [
    { name: 'Default', value: '' },
    { name: 'Caution', value: '#d69a2e' },
    { name: 'Go', value: '#58ad76' },
    { name: 'Alert', value: '#c25f52' },
    { name: 'Advisory', value: '#6fa8c9' },
    { name: 'Dim', value: '#949494' }
  ];

  const MARKERS = [
    { name: 'None', value: '' },
    { name: 'Caution', value: 'rgba(214,154,46,0.32)' },
    { name: 'Go', value: 'rgba(88,173,118,0.30)' },
    { name: 'Alert', value: 'rgba(194,95,82,0.30)' }
  ];

  const activeLabel = $derived(store.labelById(labelId));

  function closeAll() {
    inkOpen = markerOpen = labelOpen = false;
  }
</script>

<svelte:window onclick={closeAll} />

<div class="rail" role="toolbar" aria-label="Formatting">
  <div class="grp">
    <button
      class="sw sw-icon"
      aria-pressed={marks.bold}
      title="Bold · Ctrl+B"
      aria-label="Bold"
      onclick={() => cmd('fmt.bold')}><b>B</b></button
    >
    <button
      class="sw sw-icon it"
      aria-pressed={marks.italic}
      title="Italic · Ctrl+I"
      aria-label="Italic"
      onclick={() => cmd('fmt.italic')}><i>I</i></button
    >
    <button
      class="sw sw-icon un"
      aria-pressed={marks.underline}
      title="Underline · Ctrl+U"
      aria-label="Underline"
      onclick={() => cmd('fmt.underline')}><u>U</u></button
    >
    <button
      class="sw sw-icon st"
      aria-pressed={marks.strike}
      title="Strikethrough · Ctrl+Shift+X"
      aria-label="Strikethrough"
      onclick={() => cmd('fmt.strike')}><s>S</s></button
    >
  </div>

  <span class="div"></span>

  <div class="grp size">
    <button class="sw sw-icon" title="Smaller · Ctrl+[" aria-label="Smaller text" onclick={() => cmd('fmt.smaller')}>−</button>
    <select
      class="mono size-pick"
      aria-label="Font size"
      value={String(size)}
      onchange={(e) => cmd('fmt.size', e.currentTarget.value)}
    >
      {#if !FONT_SIZES.includes(size)}
        <option value={String(size)}>{size}</option>
      {/if}
      {#each FONT_SIZES as s (s)}
        <option value={String(s)}>{s}</option>
      {/each}
    </select>
    <button class="sw sw-icon" title="Bigger · Ctrl+]" aria-label="Bigger text" onclick={() => cmd('fmt.bigger')}>+</button>
  </div>

  <span class="div"></span>

  <div class="grp">
    <div class="pop-wrap">
      <button
        class="sw sw-icon"
        title="Text colour"
        aria-label="Text colour"
        aria-expanded={inkOpen}
        onclick={(e) => {
          e.stopPropagation();
          markerOpen = labelOpen = false;
          inkOpen = !inkOpen;
        }}
      >
        <span class="ink-glyph">A</span>
      </button>
      {#if inkOpen}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="pop plate" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
          {#each INKS as c (c.name)}
            <button
              class="chip"
              title={c.name}
              aria-label={c.name}
              onclick={() => {
                cmd('fmt.ink', c.value);
                inkOpen = false;
              }}
            >
              <span class="dot" style:background={c.value || 'var(--ink)'}></span>
              <span class="legend legend-sm">{c.name}</span>
            </button>
          {/each}
          <label class="chip custom">
            <input
              type="color"
              aria-label="Custom text colour"
              oninput={(e) => cmd('fmt.ink', e.currentTarget.value)}
            />
            <span class="legend legend-sm">Custom</span>
          </label>
        </div>
      {/if}
    </div>

    <div class="pop-wrap">
      <button
        class="sw sw-icon"
        title="Marker"
        aria-label="Marker"
        aria-expanded={markerOpen}
        onclick={(e) => {
          e.stopPropagation();
          inkOpen = labelOpen = false;
          markerOpen = !markerOpen;
        }}
      >
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path d="M3 11.5h10" stroke="var(--anc-amber)" stroke-width="3" fill="none" />
          <path d="M4.5 8.5h7" stroke="currentColor" fill="none" />
        </svg>
      </button>
      {#if markerOpen}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="pop plate" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
          {#each MARKERS as c (c.name)}
            <button
              class="chip"
              aria-label={c.name}
              onclick={() => {
                cmd('fmt.marker', c.value);
                markerOpen = false;
              }}
            >
              <span class="dot" style:background={c.value || 'transparent'} class:hollow={!c.value}></span>
              <span class="legend legend-sm">{c.name}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <span class="div"></span>

  <div class="grp">
    <button
      class="sw sw-icon"
      aria-pressed={marks.ul}
      title="Bullet list · Ctrl+Shift+8"
      aria-label="Bullet list"
      onclick={() => cmd('fmt.ul')}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <circle cx="3" cy="4.5" r="1.2" fill="currentColor" />
        <circle cx="3" cy="8" r="1.2" fill="currentColor" />
        <circle cx="3" cy="11.5" r="1.2" fill="currentColor" />
        <path d="M6.5 4.5H14M6.5 8H14M6.5 11.5H14" stroke="currentColor" fill="none" />
      </svg>
    </button>
    <button
      class="sw sw-icon"
      aria-pressed={marks.ol}
      title="Numbered list · Ctrl+Shift+7"
      aria-label="Numbered list"
      onclick={() => cmd('fmt.ol')}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <text x="0.5" y="6" font-size="5.5" fill="currentColor" font-family="monospace">1</text>
        <text x="0.5" y="13" font-size="5.5" fill="currentColor" font-family="monospace">2</text>
        <path d="M6.5 4.5H14M6.5 11H14" stroke="currentColor" fill="none" />
      </svg>
    </button>
    <button class="sw sw-icon" title="Align left" aria-label="Align left" onclick={() => cmd('fmt.left')}>
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <path d="M2 4h12M2 8h8M2 12h11" stroke="currentColor" fill="none" />
      </svg>
    </button>
    <button class="sw sw-icon" title="Align centre" aria-label="Align centre" onclick={() => cmd('fmt.center')}>
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <path d="M2 4h12M4 8h8M2.5 12h11" stroke="currentColor" fill="none" />
      </svg>
    </button>
    <button class="sw sw-icon" title="Clear formatting · Ctrl+Space" aria-label="Clear formatting" onclick={() => cmd('fmt.clear')}>
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <path d="M3 13h10M5 3l6 7M11 3l-6 7" stroke="currentColor" fill="none" />
      </svg>
    </button>
  </div>

  <span class="spacer"></span>

  <div class="grp right">
    <div class="pop-wrap">
      <button
        class="sw label-pick"
        aria-expanded={labelOpen}
        title="Label"
        onclick={(e) => {
          e.stopPropagation();
          inkOpen = markerOpen = false;
          labelOpen = !labelOpen;
        }}
      >
        <span
          class="dot"
          style:background={activeLabel?.color ?? 'transparent'}
          class:hollow={!activeLabel}
        ></span>
        {activeLabel?.name ?? 'No label'}
      </button>
      {#if labelOpen}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="pop plate right-pop" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
          <button
            class="chip"
            onclick={() => {
              cmd('note.label', '');
              labelOpen = false;
            }}
          >
            <span class="dot hollow"></span>
            <span class="legend legend-sm">No label</span>
          </button>
          {#each store.labels.filter((l) => !l.hidden) as l (l.id)}
            <button
              class="chip"
              onclick={() => {
                cmd('note.label', String(l.id));
                labelOpen = false;
              }}
            >
              <span class="dot" style:background={l.color}></span>
              <span class="legend legend-sm">{l.name}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <button
      class="sw sw-icon"
      aria-pressed={pinned}
      title={pinned ? 'Unpin' : 'Pin to top'}
      aria-label={pinned ? 'Unpin' : 'Pin to top'}
      onclick={() => cmd('note.pin')}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path d="M8 2.5l4 5H9.2L8.6 13 8 7.5H4z" fill="currentColor" />
      </svg>
    </button>

    <button class="sw complete" aria-pressed={archived} onclick={() => cmd('note.complete')}>
      <span class="anc {archived ? 'anc-green' : 'anc-off'}"></span>
      {archived ? 'Stowed' : 'Complete'}
    </button>
  </div>
</div>

<style>
  .rail {
    /* Never absorbed by the column that holds it: the rail is a fixed bezel. */
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 2px;
    height: var(--rail);
    padding: 0 6px;
    background: var(--panel-1);
    border-bottom: 1px solid var(--hairline);
    box-shadow: inset 0 1px 0 0 var(--bezel);
    overflow: visible;
  }

  .grp {
    display: flex;
    align-items: center;
    gap: 1px;
  }

  .div {
    width: 1px;
    height: 16px;
    background: var(--hairline);
    margin: 0 5px;
    flex: none;
  }

  .spacer {
    flex: 1 1 auto;
  }

  .sw b,
  .sw i,
  .sw u,
  .sw s {
    font-family: var(--font-body);
    font-size: 13px;
  }

  .it i {
    font-size: 13px;
  }

  .size {
    gap: 1px;
  }

  .size-pick {
    height: var(--row);
    width: 54px;
    text-align: center;
    background: var(--panel-0);
    border: 1px solid var(--hairline);
    border-radius: var(--r);
    color: var(--ink-soft);
    font-size: 11px;
  }

  .ink-glyph {
    font-family: var(--font-body);
    font-size: 13px;
    border-bottom: 2px solid var(--anc-amber);
    line-height: 1.1;
  }

  .pop-wrap {
    position: relative;
  }

  .pop {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 40;
    min-width: 128px;
    padding: 3px;
    display: grid;
    gap: 1px;
    background: var(--panel-3);
  }

  .right-pop {
    left: auto;
    right: 0;
  }

  .chip {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 24px;
    padding: 0 7px;
    background: none;
    border: 0;
    border-radius: var(--r);
    cursor: default;
    text-align: left;
    width: 100%;
  }

  .chip:hover {
    background: var(--panel-1);
  }

  .chip .legend {
    color: var(--ink-soft);
  }

  .dot {
    width: 9px;
    height: 9px;
    border-radius: 1px;
    flex: none;
  }

  .dot.hollow {
    border: 1px solid var(--legend-dim);
    background: transparent;
  }

  .custom input[type='color'] {
    width: 9px;
    height: 9px;
    padding: 0;
    border: 0;
    background: none;
  }

  .label-pick {
    gap: 7px;
    padding: 0 9px;
    max-width: 150px;
  }

  .complete {
    padding: 0 10px;
  }

  .complete[aria-pressed='true'] {
    color: var(--anc-green);
  }

  .complete .anc {
    gap: 0;
  }
</style>
