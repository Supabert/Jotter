<script lang="ts">
  import { onMount } from 'svelte';
  import { openPath } from '@tauri-apps/plugin-opener';
  import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';
  import { api } from '../api';
  import { store } from '../store.svelte';

  let dir = $state('');
  let autostart = $state(false);
  let hotkey = $state('Ctrl+Alt+N');
  let newName = $state('');
  let newColor = $state('#6fa8c9');
  /* One drag id per list. A single shared one lets a label dropped on a
     project row reorder the wrong list. */
  let dragId = $state<number | null>(null);
  let dragProject = $state<number | null>(null);
  let dragStage = $state<number | null>(null);
  let newProject = $state('');
  let newProjectColor = $state('#4b86a3');
  let newStage = $state('');

  onMount(async () => {
    dir = await api.dataDir();
    autostart = await isEnabled().catch(() => false);
    hotkey = store.settings['hotkey'] ?? 'Ctrl+Alt+N';
  });

  async function toggleAutostart() {
    autostart = !autostart;
    if (autostart) await enable();
    else await disable();
  }

  async function saveHotkey() {
    try {
      await api.rebindHotkey(hotkey);
      await store.setSetting('hotkey', hotkey);
      store.flash('Hotkey registered', 'green');
    } catch (e) {
      store.flash(`Hotkey refused: ${e}`, 'red');
    }
  }

  async function addLabel() {
    const name = newName.trim();
    if (!name) return;
    await api.createLabel(name, newColor);
    newName = '';
    store.labels = await api.listLabels();
  }

  async function saveLabel(id: number, name: string, color: string, hidden: boolean) {
    await api.updateLabel(id, name, color, hidden);
    store.labels = await api.listLabels();
    await store.refreshNotes();
  }

  async function dropLabel(targetId: number) {
    if (dragId === null || dragId === targetId) return;
    const ids = store.labels.map((l) => l.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    ids.splice(to, 0, ...ids.splice(from, 1));
    dragId = null;
    await api.reorderLabels(ids);
    store.labels = await api.listLabels();
  }

  // --- projects -----------------------------------------------------------

  async function addProject() {
    const name = newProject.trim();
    if (!name) return;
    await api.createProject(name, newProjectColor);
    newProject = '';
    await store.refreshBoard();
  }

  async function saveProject(id: number, name: string, color: string, hidden: boolean) {
    await api.updateProject(id, name, color, hidden);
    await store.refreshBoard();
  }

  async function dropProject(targetId: number) {
    if (dragProject === null || dragProject === targetId) return;
    const ids = store.projects.map((p) => p.id);
    const from = ids.indexOf(dragProject);
    const to = ids.indexOf(targetId);
    ids.splice(to, 0, ...ids.splice(from, 1));
    dragProject = null;
    await api.reorderProjects(ids);
    await store.refreshBoard();
  }

  // --- board columns ------------------------------------------------------

  async function addStage() {
    const name = newStage.trim();
    if (!name) return;
    await api.createStage(name);
    newStage = '';
    await store.refreshBoard();
  }

  /** Hiding a column empties it into the first visible one; the count comes
      back so the toast can say what actually happened rather than implying
      nothing did. */
  async function saveStage(id: number, name: string, hidden: boolean) {
    const moved = await api.updateStage(id, name, hidden);
    await store.refreshBoard();
    await store.refreshActions();
    if (moved > 0) {
      store.flash(`${moved} card${moved === 1 ? '' : 's'} moved to the first column`, 'amber');
    }
  }

  async function dropStage(targetId: number) {
    if (dragStage === null || dragStage === targetId) return;
    const ids = store.stages.map((x) => x.id);
    const from = ids.indexOf(dragStage);
    const to = ids.indexOf(targetId);
    ids.splice(to, 0, ...ids.splice(from, 1));
    dragStage = null;
    await api.reorderStages(ids);
    await store.refreshBoard();
  }

  async function backup() {
    try {
      const path = await api.backupNow();
      store.flash(`Backed up to ${path.split('\\').pop()}`, 'green');
    } catch (e) {
      store.flash(String(e), 'red');
    }
  }
</script>

<div class="sheet scroll">
  <div class="page">
    <h1 class="legend title">Settings</h1>

    <section>
      <h2 class="legend head">Labels</h2>
      <p class="note">
        A label is a thumb tab. Its colour marks the note's edge in the sidebar. Hiding one
        keeps every note that carries it — nothing here deletes anything.
      </p>

      <div class="labels">
        {#each store.labels as l (l.id)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="lrow"
            class:hidden={l.hidden}
            draggable="true"
            ondragstart={() => (dragId = l.id)}
            ondragover={(e) => e.preventDefault()}
            ondrop={() => dropLabel(l.id)}
          >
            <span class="grip legend-sm" aria-hidden="true">⠿</span>
            <input
              class="swatch-in"
              type="color"
              value={l.color}
              aria-label={`Colour for ${l.name}`}
              onchange={(e) => saveLabel(l.id, l.name, e.currentTarget.value, l.hidden)}
            />
            <input
              class="lname"
              type="text"
              value={l.name}
              aria-label="Label name"
              onblur={(e) => saveLabel(l.id, e.currentTarget.value.trim() || l.name, l.color, l.hidden)}
            />
            <span class="mono count">
              {store.notes.filter((n) => n.label_id === l.id).length}
            </span>
            <button
              class="sw"
              aria-pressed={l.hidden}
              onclick={() => saveLabel(l.id, l.name, l.color, !l.hidden)}
            >
              {l.hidden ? 'Hidden' : 'Visible'}
            </button>
          </div>
        {/each}

        <div class="lrow add">
          <span class="grip" aria-hidden="true"></span>
          <input class="swatch-in" type="color" bind:value={newColor} aria-label="New label colour" />
          <input
            class="lname"
            type="text"
            bind:value={newName}
            placeholder="New label"
            onkeydown={(e) => e.key === 'Enter' && addLabel()}
          />
          <span></span>
          <button class="sw" disabled={!newName.trim()} onclick={addLabel}>Add</button>
        </div>
      </div>
    </section>

    <section>
      <h2 class="legend head">Projects</h2>
      <p class="note">
        A project is what an action is part of; a label is where a note lives. They are
        separate lists on purpose, so an action captured in a Scratch note can still
        belong to real work. Hiding a project keeps every action that carries it.
      </p>

      <div class="labels">
        {#each store.projects as p (p.id)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="lrow"
            class:hidden={p.hidden}
            draggable="true"
            ondragstart={() => (dragProject = p.id)}
            ondragover={(e) => e.preventDefault()}
            ondrop={() => dropProject(p.id)}
          >
            <span class="grip legend-sm" aria-hidden="true">&#10303;</span>
            <input
              class="swatch-in"
              type="color"
              value={p.color}
              aria-label={`Colour for ${p.name}`}
              onchange={(e) => saveProject(p.id, p.name, e.currentTarget.value, p.hidden)}
            />
            <input
              class="lname"
              type="text"
              value={p.name}
              aria-label="Project name"
              onblur={(e) =>
                saveProject(p.id, e.currentTarget.value.trim() || p.name, p.color, p.hidden)}
            />
            <span class="mono count">
              {store.actions.filter((a) => a.project_id === p.id).length}
            </span>
            <button
              class="sw"
              aria-pressed={p.hidden}
              onclick={() => saveProject(p.id, p.name, p.color, !p.hidden)}
            >
              {p.hidden ? 'Hidden' : 'Visible'}
            </button>
          </div>
        {/each}

        <div class="lrow add">
          <span class="grip" aria-hidden="true"></span>
          <input
            class="swatch-in"
            type="color"
            bind:value={newProjectColor}
            aria-label="New project colour"
          />
          <input
            class="lname"
            type="text"
            bind:value={newProject}
            placeholder="New project"
            onkeydown={(e) => e.key === 'Enter' && addProject()}
          />
          <span></span>
          <button class="sw" disabled={!newProject.trim()} onclick={addProject}>Add</button>
        </div>
      </div>
    </section>

    <section>
      <h2 class="legend head">Board columns</h2>
      <p class="note">
        The columns on the Actions board, left to right. Finishing a card does not move
        it: it stays in the column it was worked in, folded under that column's
        "Show completed". Hiding a column moves its cards to the first one rather than
        losing them. The board itself can rename, reorder, add and delete columns; this
        is the fuller editor, with counts and what is hidden.
      </p>

      <div class="labels">
        {#each store.stages as st (st.id)}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="lrow stage"
            class:hidden={st.hidden}
            draggable="true"
            ondragstart={() => (dragStage = st.id)}
            ondragover={(e) => e.preventDefault()}
            ondrop={() => dropStage(st.id)}
          >
            <span class="grip legend-sm" aria-hidden="true">&#10303;</span>
            <input
              class="lname"
              type="text"
              value={st.name}
              aria-label="Column name"
              onblur={(e) => saveStage(st.id, e.currentTarget.value.trim() || st.name, st.hidden)}
            />
            <span class="mono count">
              {store.actions.filter((a) => store.stageOf(a) === st.id).length}
            </span>
            <button
              class="sw"
              aria-pressed={st.hidden}
              title="Show or hide this column"
              onclick={() => saveStage(st.id, st.name, !st.hidden)}
            >
              {st.hidden ? 'Hidden' : 'Visible'}
            </button>
          </div>
        {/each}

        <div class="lrow stage add">
          <span class="grip" aria-hidden="true"></span>
          <input
            class="lname"
            type="text"
            bind:value={newStage}
            placeholder="New column"
            onkeydown={(e) => e.key === 'Enter' && addStage()}
          />
          <span></span>
          <button class="sw" disabled={!newStage.trim()} onclick={addStage}>Add</button>
        </div>
      </div>
    </section>

    <section>
      <h2 class="legend head">Panel lighting</h2>
      <div class="opts">
        {#each [['night', 'Night'], ['day', 'Day'], ['system', 'Follow Windows']] as [v, label] (v)}
          <button
            class="sw"
            aria-pressed={store.theme === v}
            onclick={() => store.setTheme(v as 'night' | 'day' | 'system')}
          >
            {label}
          </button>
        {/each}
      </div>
    </section>

    <section>
      <h2 class="legend head">Quick capture</h2>
      <p class="note">
        Fires from anywhere in Windows. If another app already owns the combination, Jotter
        says so rather than failing silently.
      </p>
      <div class="opts">
        <input class="hk mono" type="text" bind:value={hotkey} aria-label="Global capture hotkey" />
        <button class="sw" onclick={saveHotkey}>Register</button>
        <button class="sw" onclick={() => api.openCapture()}>Test it</button>
      </div>
    </section>

    <section>
      <h2 class="legend head">Startup</h2>
      <div class="opts">
        <button class="sw" aria-pressed={autostart} onclick={toggleAutostart}>
          <span class="anc {autostart ? 'anc-green' : 'anc-off'}"></span>
          {autostart ? 'Starts with Windows' : 'Does not start with Windows'}
        </button>
      </div>
    </section>

    <section>
      <h2 class="legend head">Data</h2>
      <p class="note">
        Everything lives here as plain files. Jotter makes no network calls of any kind.
        Completing a note strikes it through and stows it; the only thing that ever
        destroys anything is the bin on a sidebar row, and it says so twice first.
      </p>
      <div class="opts">
        <code class="path mono">{dir}</code>
      </div>
      <div class="opts">
        <button class="sw" onclick={() => openPath(dir)}>Open data folder</button>
        <button class="sw" onclick={backup}>Back up now</button>
      </div>
    </section>

    <section>
      <h2 class="legend head">Session</h2>
      <div class="opts">
        <button class="sw" onclick={() => api.quit()}>Quit Jotter</button>
        <span class="note inline">Closing the window parks Jotter in the tray instead.</span>
      </div>
    </section>
  </div>
</div>

<style>
  .sheet {
    display: flex;
    justify-content: center;
    align-items: stretch;
  }

  .page {
    flex: 0 1 760px;
    min-height: 100%;
    height: max-content;
    background: var(--panel-2);
    border-left: 1px solid var(--hairline);
    border-right: 1px solid var(--hairline);
    padding: 22px 26px 44px;
  }

  .title {
    font-size: 15px;
    letter-spacing: 0.14em;
    color: var(--ink);
    margin: 0 0 20px;
  }

  section {
    padding: 16px 0;
    border-top: 1px solid var(--hairline);
  }

  .head {
    font-size: 10.5px;
    color: var(--legend);
    margin: 0 0 8px;
  }

  .note {
    font-size: 12px;
    color: var(--legend);
    margin: 0 0 12px;
    max-width: 62ch;
    line-height: 1.55;
  }

  .note.inline {
    margin: 0;
    align-self: center;
  }

  .opts {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: 6px;
  }

  .labels {
    display: grid;
    gap: 1px;
  }

  .lrow {
    display: grid;
    grid-template-columns: 16px 22px minmax(0, 1fr) 34px auto;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    background: var(--panel-3);
    border: 1px solid var(--hairline);
    border-radius: var(--r);
  }

  /* A column row has no colour well, so it gets its own track list rather
     than inheriting one and putting the name input in a 22px swatch slot. */
  .lrow.stage {
    grid-template-columns: 16px minmax(0, 1fr) 34px auto;
  }

  .lrow.hidden {
    opacity: 0.5;
  }

  .lrow.add {
    background: transparent;
    border-style: dashed;
  }

  .grip {
    color: var(--legend-dim);
    font-size: 11px;
    text-align: center;
    cursor: grab;
  }

  .swatch-in {
    width: 22px;
    height: 20px;
    padding: 0;
    border: 1px solid var(--hairline);
    border-radius: 1px;
    background: none;
  }

  .lname {
    background: transparent;
    border: 0;
    height: 24px;
    font-size: 13px;
  }

  .lname:focus {
    outline: none;
    box-shadow: inset 0 -1px 0 var(--focus);
  }

  .count {
    text-align: right;
    color: var(--legend-dim);
    font-size: 10.5px;
  }

  .hk {
    width: 190px;
    font-size: 11.5px;
  }

  .path {
    display: block;
    padding: 6px 9px;
    background: var(--panel-0);
    border: 1px solid var(--hairline);
    border-radius: var(--r);
    color: var(--ink-soft);
    font-size: 11.5px;
    word-break: break-all;
  }
</style>
