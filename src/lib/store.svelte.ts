import {
  api,
  type Action,
  type Attachment,
  type Label,
  type NoteSummary,
  type Project,
  type Stage
} from './api';
import * as scale from './timeline/scale';
import type { Domain, Zoom } from './timeline/scale';

/** How the timeline orders rows inside a project group. */
export type TimelineSort = 'manual' | 'start' | 'due';

/** One project's band of rows on the chart, plus the span they add up to. */
export interface TimelineGroup {
  key: string;
  projectId: number | null;
  name: string;
  color: string | null;
  collapsed: boolean;
  /** Drawn rows: everything in the group that has at least one date. */
  items: Action[];
  /** In the group but undrawable, so the header can say what is missing. */
  undated: number;
  /** Earliest start to latest due across `items`. Computed every render. */
  rollup: Domain | null;
}

/** One of the three things that can be on the stage. Only ever one at a time. */
export type View =
  | { kind: 'note'; id: number }
  | { kind: 'actions' }
  | { kind: 'settings' };

export interface NoteGroup {
  key: string;
  name: string;
  color: string | null;
  notes: NoteSummary[];
}

export type GroupBy = 'none' | 'label' | 'date';
export type SortBy = 'updated' | 'created' | 'title' | 'label';

export function viewKey(v: View): string {
  return v.kind === 'note' ? `note:${v.id}` : v.kind;
}

function parseKey(key: string): View | null {
  if (key === 'actions' || key === 'settings') return { kind: key };
  const m = /^note:(\d+)$/.exec(key);
  return m ? { kind: 'note', id: Number(m[1]) } : null;
}

const BUCKETS = ['Today', 'Yesterday', 'This week', 'This month', 'Older'];

function dateBucket(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const key = localDate(d);
  if (key === localDate(today)) return 'Today';
  const yest = new Date(today);
  yest.setDate(today.getDate() - 1);
  if (key === localDate(yest)) return 'Yesterday';
  const days = (today.getTime() - d.getTime()) / 86_400_000;
  if (days < 7) return 'This week';
  if (days < 31) return 'This month';
  return 'Older';
}

class Store {
  notes = $state<NoteSummary[]>([]);
  labels = $state<Label[]>([]);
  actions = $state<Action[]>([]);
  projects = $state<Project[]>([]);
  stages = $state<Stage[]>([]);
  settings = $state<Record<string, string>>({});

  /**
   * The single thing on the stage. There is no tab bar — the sidebar list *is*
   * the list of open things, so a second row of the same names would have been
   * the same information twice.
   */
  activeKey = $state<string>('actions');
  /** Where Ctrl+W goes back to. Most recent last. */
  history = $state<string[]>([]);

  showArchived = $state(false);
  /** Which way the Actions page is being read: checklist, board or chart. */
  actionsView = $state<'list' | 'board' | 'timeline'>('list');

  /**
   * Today, as a reactive value.
   *
   * Not a constant computed at import time. Jotter lives in the tray for weeks
   * without a restart, and a chart whose red line and whose overdue reds were
   * decided at launch would quietly start lying at the first midnight. See
   * `startClock`.
   */
  today = $state(localDate());

  timelineZoom = $state<Zoom>('day');
  timelineSort = $state<TimelineSort>('manual');
  /** How far either side of today the chart reaches, in days. */
  timelineBack = $state(scale.DEFAULT_BACK);
  timelineFwd = $state(scale.DEFAULT_FWD);
  /** When on, the window ignores back/forward and spans the work instead. */
  timelineFit = $state(false);
  /** Project ids whose rows are folded away. `0` stands for "No project". */
  timelineCollapsed = $state<number[]>([]);
  /** Finished work still happened, so its bar is drawn — flat and muted — until
      this is turned off. */
  timelineShowDone = $state(true);
  /** Board filter. `null` is every project, `0` is the ones with none. */
  boardProject = $state<number | null>(null);
  /** The card whose detail panel is open, by action id. */
  openCard = $state<number | null>(null);
  /** How the cards inside every column are ordered. `manual` is the hand-sorted
      `board_order`; the others are computed, and a drag inside one column has
      nothing to write while they are on. */
  boardSort = $state<'manual' | 'due' | 'project'>('manual');
  groupBy = $state<GroupBy>('none');
  sortBy = $state<SortBy>('updated');
  theme = $state<'night' | 'day' | 'system'>('night');
  /** What `theme` actually resolved to — `system` is not a lighting state. */
  lighting = $state<'night' | 'day'>('night');
  focusMode = $state(false);

  overlay = $state<'none' | 'palette' | 'search' | 'find'>('none');

  /** Bumped when an action is logged, so the pinned 00 lamp can blip once. */
  blip = $state(0);
  toast = $state<{
    text: string;
    tone: 'green' | 'amber' | 'red';
    /** One offered reversal, alive as long as the toast is. */
    undo?: () => void;
  } | null>(null);

  /** Set when the Actions page asks the editor to reveal a specific anchor. */
  revealAnchor = $state<{ noteId: number; anchorId: string } | null>(null);

  /** What the status strip reports. Owned by whichever editor is mounted. */
  stats = $state<{ words: number; chars: number; savedAt: string | null }>({
    words: 0,
    chars: 0,
    savedAt: null
  });

  get active(): View | null {
    const v = parseKey(this.activeKey);
    // A note that has been deleted out from under the stage resolves to
    // nothing rather than to an editor pointed at a missing row.
    if (v?.kind === 'note' && !this.notes.some((n) => n.id === v.id)) return null;
    return v;
  }

  get openActionCount(): number {
    return this.actions.filter((a) => !a.done && !a.archived).length;
  }

  get overdueCount(): number {
    return this.actions.filter(
      (a) => !a.done && !a.archived && a.due_date !== null && a.due_date < this.today
    ).length;
  }

  /** Late, as every view asks it. One definition, so the chart, the board and
      the checklist cannot disagree about what red means. */
  isOverdue(a: Action): boolean {
    return scale.isOverdue(a, this.today);
  }

  labelById(id: number | null | undefined): Label | undefined {
    if (id === null || id === undefined) return undefined;
    return this.labels.find((l) => l.id === id);
  }

  projectById(id: number | null | undefined): Project | undefined {
    if (id === null || id === undefined) return undefined;
    return this.projects.find((p) => p.id === id);
  }

  get visibleStages(): Stage[] {
    return this.stages.filter((s) => !s.hidden);
  }

  /** The column a card belongs in. A stage that was hidden or a row that
      predates the board both land in the first visible column rather than
      vanishing. Completion is never consulted: finishing something does not
      move it, it only folds it under that column's disclosure. */
  stageOf(a: Action): number | null {
    const own = this.visibleStages.find((s) => s.id === a.stage_id);
    if (own) return own.id;
    return this.visibleStages[0]?.id ?? null;
  }

  /** The open cards in a column, project filter ignored — the order a manual
      reorder has to write back. Writing back a filtered subset would renumber
      those cards on top of the ones the filter is hiding, and completed cards
      are not in the hand-sorted run at all. */
  columnOrder(stageId: number): number[] {
    return this.actions
      .filter((a) => !a.done && this.stageOf(a) === stageId)
      .sort((x, y) => x.board_order - y.board_order || x.id - y.id)
      .map((a) => a.id);
  }

  /** The action the detail panel is showing, re-read from the live list on
      every change so the panel never renders a stale copy of a row the board
      has already moved. */
  get openAction(): Action | undefined {
    if (this.openCard === null) return undefined;
    return this.actions.find((a) => a.id === this.openCard);
  }

  private inFilter(a: Action): boolean {
    return (
      this.boardProject === null ||
      (this.boardProject === 0 ? a.project_id === null : a.project_id === this.boardProject)
    );
  }

  /** Whatever `boardSort` says. Ties always fall back to the hand-sorted order,
      so a sort never scrambles cards it has no opinion about. */
  private ranked(list: Action[]): Action[] {
    const manual = (x: Action, y: Action) => x.board_order - y.board_order || x.id - y.id;
    if (this.boardSort === 'due') {
      return list.sort(
        (x, y) =>
          // No due date is not "due first". It goes last, where it stops
          // competing with the things that actually have a date.
          Number(x.due_date === null) - Number(y.due_date === null) ||
          (x.due_date ?? '').localeCompare(y.due_date ?? '') ||
          manual(x, y)
      );
    }
    if (this.boardSort === 'project') {
      const rank = (a: Action) => {
        const p = this.projectById(a.project_id);
        return p ? p.sort_order : Number.MAX_SAFE_INTEGER;
      };
      return list.sort((x, y) => rank(x) - rank(y) || manual(x, y));
    }
    return list.sort(manual);
  }

  /** The open cards in one column, as the board is filtered and sorted. */
  cardsIn(stageId: number): Action[] {
    return this.ranked(
      this.actions.filter((a) => !a.done && this.stageOf(a) === stageId && this.inFilter(a))
    );
  }

  /** The finished cards in one column. Most recently finished first, so the one
      you just ticked is at the top of the disclosure you saw it fall into. */
  completedIn(stageId: number): Action[] {
    return this.actions
      .filter((a) => a.done && this.stageOf(a) === stageId && this.inFilter(a))
      .sort((x, y) => (y.done_at ?? '').localeCompare(x.done_at ?? '') || y.id - x.id);
  }

  // --- timeline -----------------------------------------------------------
  //
  // The chart is a third reading of the same rows. It groups by project rather
  // than by stage, orders by `timeline_order` rather than `board_order`, and
  // draws only what carries a date — but every row it draws is a row the board
  // is drawing too, and completion is still the one field on the one row.

  /** `0` is the key the No-project group folds under; real ids are positive. */
  private collapseKey(projectId: number | null): number {
    return projectId ?? 0;
  }

  /**
   * Which band a row belongs to on the chart.
   *
   * A project that has been hidden must not take its work off the chart with
   * it — hiding has never meant deleting anywhere else in this app, and a
   * hidden label keeps every note that carries it. Those rows fall to No
   * project, which is already where work with no visible home lives. Both the
   * grouping and the order that gets written back read this, so a drop can
   * never renumber against a different idea of the group.
   */
  timelineGroupOf(a: Action): number | null {
    const p = this.projectById(a.project_id);
    return p && !p.hidden ? p.id : null;
  }

  isCollapsed(projectId: number | null): boolean {
    return this.timelineCollapsed.includes(this.collapseKey(projectId));
  }

  /** Everything the chart could draw, before grouping: the project filter and
      the completed toggle applied, undated rows still included so a group can
      count what it is not showing. */
  private timelinePool(): Action[] {
    return this.actions.filter(
      (a) => (this.timelineShowDone || !a.done) && this.inFilter(a)
    );
  }

  private rankTimeline(list: Action[]): Action[] {
    const manual = (x: Action, y: Action) =>
      x.timeline_order - y.timeline_order || x.id - y.id;
    if (this.timelineSort === 'manual') return list.sort(manual);
    const key = this.timelineSort === 'start' ? 'start_date' : 'due_date';
    return list.sort(
      (x, y) =>
        // Undated rows are not drawn at all, but a row dated on only its other
        // end still sorts here, and it goes last rather than pretending to be
        // the earliest thing in the group.
        Number(x[key] === null) - Number(y[key] === null) ||
        (x[key] ?? '').localeCompare(y[key] ?? '') ||
        manual(x, y)
    );
  }

  /** The chart's rows, banded by project. Projects keep their own order, and
      No-project sits last because it is where things have not been filed yet. */
  get timelineGroups(): TimelineGroup[] {
    const pool = this.timelinePool();
    const out: TimelineGroup[] = [];

    const build = (projectId: number | null, name: string, color: string | null) => {
      const mine = pool.filter((a) => this.timelineGroupOf(a) === projectId);
      if (mine.length === 0) return;
      const dated = this.rankTimeline(mine.filter((a) => scale.shapeOf(a) !== 'none'));
      out.push({
        key: projectId === null ? 'none' : `p${projectId}`,
        projectId,
        name,
        color,
        collapsed: this.isCollapsed(projectId),
        items: dated,
        undated: mine.length - dated.length,
        rollup: scale.rollup(dated)
      });
    };

    for (const p of this.projects.filter((x) => !x.hidden)) build(p.id, p.name, p.color);
    build(null, 'No project', null);
    return out;
  }

  /** Every dated row on the chart, whatever group it is in. What `Fit` fits. */
  get timelineDates(): string[] {
    const out: string[] = [];
    for (const g of this.timelineGroups) {
      for (const a of g.items) {
        if (a.start_date) out.push(a.start_date);
        if (a.due_date) out.push(a.due_date);
      }
    }
    return out;
  }

  /** The chart's canvas: the work when `Fit` is on, otherwise the window the
      user set either side of today. */
  get timelineDomain(): Domain {
    return this.timelineFit
      ? scale.fitDomain(this.timelineDates, this.today)
      : scale.relativeDomain(this.today, this.timelineBack, this.timelineFwd);
  }

  /** How many open actions the chart cannot draw because they carry no date.
      Printed in the header: a timeline that silently omits work is a timeline
      you cannot trust. */
  get timelineUndated(): number {
    return this.actions.filter((a) => !a.done && scale.shapeOf(a) === 'none').length;
  }

  /**
   * A project group's full order, project filter and completed toggle ignored.
   *
   * The same rule the board's `columnOrder` follows and for the same reason:
   * writing back a filtered subset renumbers those rows on top of the ones the
   * filter is hiding.
   */
  groupOrder(projectId: number | null): number[] {
    return this.actions
      .filter((a) => this.timelineGroupOf(a) === projectId)
      .sort((x, y) => x.timeline_order - y.timeline_order || x.id - y.id)
      .map((a) => a.id);
  }

  async toggleCollapsed(projectId: number | null): Promise<void> {
    const key = this.collapseKey(projectId);
    this.timelineCollapsed = this.timelineCollapsed.includes(key)
      ? this.timelineCollapsed.filter((k) => k !== key)
      : [...this.timelineCollapsed, key];
    await this.setSetting('timeline_collapsed', this.timelineCollapsed.join(','));
  }

  async setTimelineZoom(zoom: Zoom): Promise<void> {
    this.timelineZoom = zoom;
    await this.setSetting('timeline_zoom', zoom);
  }

  async setTimelineSort(sort: TimelineSort): Promise<void> {
    this.timelineSort = sort;
    await this.setSetting('timeline_sort', sort);
  }

  async setTimelineShowDone(show: boolean): Promise<void> {
    this.timelineShowDone = show;
    await this.setSetting('timeline_show_done', show ? '1' : '0');
  }

  /** `fit` and a back/forward window are two answers to the same question, so
      setting either one turns the other off. */
  async setTimelineRange(back: number, fwd: number): Promise<void> {
    this.timelineBack = back;
    this.timelineFwd = fwd;
    this.timelineFit = false;
    await Promise.all([
      this.setSetting('timeline_back', String(back)),
      this.setSetting('timeline_fwd', String(fwd)),
      this.setSetting('timeline_fit', '0')
    ]);
  }

  async setTimelineFit(fit: boolean): Promise<void> {
    this.timelineFit = fit;
    await this.setSetting('timeline_fit', fit ? '1' : '0');
  }

  /**
   * Keeps `today` true across midnight.
   *
   * The app sits in the tray for weeks. Without this the red line and every
   * overdue red would be frozen at whatever the date was when Jotter last
   * started — and a chart that is quietly a day out is worse than no chart.
   * Re-armed rather than left on an interval so it stays exact after a laptop
   * sleeps through the boundary.
   */
  startClock(): () => void {
    let timer: number;
    const arm = () => {
      const now = new Date();
      const midnight = new Date(now);
      midnight.setHours(24, 0, 0, 0);
      timer = setTimeout(() => {
        this.today = localDate();
        arm();
      }, midnight.getTime() - now.getTime() + 500) as unknown as number;
    };
    arm();
    return () => clearTimeout(timer);
  }

  // --- sidebar order ------------------------------------------------------
  //
  // The sidebar renders this and the keyboard walks it. Both read the same
  // getter on purpose: when Ctrl+Tab and the visible list disagree about what
  // comes next, the list is right and the keyboard is a bug.

  get visibleNotes(): NoteSummary[] {
    return this.notes.filter((n) => this.showArchived || !n.archived);
  }

  private sorted(list: NoteSummary[]): NoteSummary[] {
    const s = [...list];
    switch (this.sortBy) {
      case 'created':
        s.sort((a, b) => b.created_at.localeCompare(a.created_at));
        break;
      case 'title':
        s.sort((a, b) => (a.title || 'Untitled').localeCompare(b.title || 'Untitled'));
        break;
      case 'label':
        s.sort((a, b) => {
          const la = this.labelById(a.label_id)?.sort_order ?? 999;
          const lb = this.labelById(b.label_id)?.sort_order ?? 999;
          return la - lb || b.updated_at.localeCompare(a.updated_at);
        });
        break;
      default:
        s.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    }
    // Pinned notes always ride above the sort inside their own group.
    return s.sort((a, b) => Number(b.pinned) - Number(a.pinned));
  }

  get groups(): NoteGroup[] {
    const visible = this.visibleNotes;

    if (this.groupBy === 'none') {
      return [{ key: 'all', name: '', color: null, notes: this.sorted(visible) }];
    }

    if (this.groupBy === 'label') {
      const out: NoteGroup[] = [];
      for (const l of this.labels.filter((x) => !x.hidden)) {
        const notes = this.sorted(visible.filter((n) => n.label_id === l.id));
        if (notes.length) out.push({ key: `l${l.id}`, name: l.name, color: l.color, notes });
      }
      const rest = this.sorted(visible.filter((n) => !this.labelById(n.label_id)));
      if (rest.length) out.push({ key: 'none', name: 'Unlabelled', color: null, notes: rest });
      return out;
    }

    const by = new Map<string, NoteSummary[]>();
    for (const n of visible) {
      const b = dateBucket(this.sortBy === 'created' ? n.created_at : n.updated_at);
      if (!by.has(b)) by.set(b, []);
      by.get(b)!.push(n);
    }
    return BUCKETS.filter((b) => by.has(b)).map((b) => ({
      key: b,
      name: b,
      color: null,
      notes: this.sorted(by.get(b)!)
    }));
  }

  async load(): Promise<void> {
    const [notes, labels, actions, projects, stages, settings] = await Promise.all([
      api.listNotes(),
      api.listLabels(),
      api.listActions(),
      api.listProjects(),
      api.listStages(),
      api.getSettings()
    ]);
    this.notes = notes;
    this.labels = labels;
    this.actions = actions;
    this.projects = projects;
    this.stages = stages;
    this.settings = settings;

    this.showArchived = settings['show_archived'] === '1';
    this.groupBy = (settings['group_by'] as GroupBy) ?? 'none';
    this.sortBy = (settings['sort_by'] as SortBy) ?? 'updated';
    this.theme = (settings['theme'] as 'night' | 'day' | 'system') ?? 'night';
    const av = settings['actions_view'];
    this.actionsView = av === 'board' || av === 'timeline' ? av : 'list';
    const sort = settings['board_sort'];
    this.boardSort = sort === 'due' || sort === 'project' ? sort : 'manual';

    const zoom = settings['timeline_zoom'];
    if (zoom && (scale.ZOOM_ORDER as string[]).includes(zoom)) this.timelineZoom = zoom as Zoom;
    const tsort = settings['timeline_sort'];
    if (tsort === 'start' || tsort === 'due' || tsort === 'manual') this.timelineSort = tsort;
    // A stored number that is not one is how a chart ends up NaN days wide.
    const back = Number(settings['timeline_back']);
    if (Number.isFinite(back) && back > 0) this.timelineBack = back;
    const fwd = Number(settings['timeline_fwd']);
    if (Number.isFinite(fwd) && fwd > 0) this.timelineFwd = fwd;
    this.timelineFit = settings['timeline_fit'] === '1';
    this.timelineShowDone = settings['timeline_show_done'] !== '0';
    this.timelineCollapsed = (settings['timeline_collapsed'] ?? '')
      .split(',')
      .map(Number)
      .filter((n) => Number.isFinite(n));

    this.applyTheme();

  }

  async refreshNotes(): Promise<void> {
    this.notes = await api.listNotes();
  }

  async refreshActions(): Promise<void> {
    this.actions = await api.listActions();
  }

  async refreshBoard(): Promise<void> {
    const [projects, stages] = await Promise.all([api.listProjects(), api.listStages()]);
    this.projects = projects;
    this.stages = stages;
  }

  async setBoardSort(sort: 'manual' | 'due' | 'project'): Promise<void> {
    this.boardSort = sort;
    await this.setSetting('board_sort', sort);
  }

  async setActionsView(view: 'list' | 'board' | 'timeline'): Promise<void> {
    this.actionsView = view;
    // A detail panel describing a card that is no longer on screen is a panel
    // about nothing.
    this.openCard = null;
    await this.setSetting('actions_view', view);
  }

  // --- settings -----------------------------------------------------------

  async setSetting(key: string, value: string): Promise<void> {
    this.settings[key] = value;
    await api.setSetting(key, value);
  }

  applyTheme(): void {
    const wantsDay =
      this.theme === 'day' ||
      (this.theme === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
    // Mirrored into state as well as onto the element: reading the attribute
    // back out of the DOM is not a reactive dependency, so the status strip
    // that did exactly that reported the lighting it was born with forever.
    this.lighting = wantsDay ? 'day' : 'night';
    document.documentElement.dataset.theme = this.lighting;
  }

  async setTheme(theme: 'night' | 'day' | 'system'): Promise<void> {
    this.theme = theme;
    this.applyTheme();
    await this.setSetting('theme', theme);
  }

  async toggleArchived(): Promise<void> {
    this.showArchived = !this.showArchived;
    await this.setSetting('show_archived', this.showArchived ? '1' : '0');
  }

  // --- navigation ---------------------------------------------------------

  go(key: string): void {
    if (key === this.activeKey) return;
    if (this.activeKey) this.history = [...this.history, this.activeKey].slice(-50);
    this.activeKey = key;
  }

  openNote(id: number): void {
    this.go(`note:${id}`);
  }

  openActions(): void {
    this.go('actions');
  }

  openSettings(): void {
    this.go('settings');
  }

  /**
   * Ctrl+W. Nothing is being closed — the note stays in the sidebar exactly
   * where it was — so this reveals whatever was underneath instead, and falls
   * back to the checklist when there is no underneath left.
   */
  back(): void {
    const trail = [...this.history];
    let key: string | undefined;
    while ((key = trail.pop())) {
      const v = parseKey(key);
      if (v && (v.kind !== 'note' || this.notes.some((n) => n.id === v.id))) break;
    }
    this.history = trail;
    this.activeKey = key ?? 'actions';
  }

  /** Sidebar order, top to bottom: the pinned checklist, then every row the
      sidebar is actually showing, in its current grouping and sort. Ctrl+Tab
      walks this and nothing else. */
  get navOrder(): string[] {
    return ['actions', ...this.groups.flatMap((g) => g.notes.map((n) => `note:${n.id}`))];
  }

  cycle(direction: 1 | -1): void {
    const order = this.navOrder;
    if (order.length < 2) return;
    const idx = order.indexOf(this.activeKey);
    // Settings is not a sidebar row, so cycling out of it enters the list at
    // one end rather than refusing to move at all.
    const next =
      idx < 0
        ? direction === 1
          ? 0
          : order.length - 1
        : (idx + direction + order.length) % order.length;
    this.go(order[next]);
  }

  /** Ctrl+1..8 pick a note by position; Ctrl+9 is the last one. The checklist
      is Ctrl+0 and is therefore skipped here. */
  goto(n: number): void {
    const notes = this.navOrder.slice(1);
    const key = n === 9 ? notes[notes.length - 1] : notes[n - 1];
    if (key) this.go(key);
  }

  // --- notes --------------------------------------------------------------

  async newNote(labelId: number | null = null): Promise<number> {
    const id = await api.createNote('', '', '', labelId);
    await this.refreshNotes();
    this.openNote(id);
    return id;
  }

  async setArchived(id: number, archived: boolean): Promise<void> {
    await api.setNoteArchived(id, archived);
    await Promise.all([this.refreshNotes(), this.refreshActions()]);
    this.flash(archived ? 'Note completed and stowed' : 'Note restored', 'green');
  }

  async setPinned(id: number, pinned: boolean): Promise<void> {
    await api.setNotePinned(id, pinned);
    await this.refreshNotes();
  }

  /**
   * The escape hatch. Everything else in Jotter stows; this is gone-gone, and
   * it takes the note's actions with it. The sidebar makes the user confirm in
   * place before it is ever called.
   */
  async deleteNote(id: number): Promise<void> {
    const key = `note:${id}`;
    await api.deleteNote(id);
    this.history = this.history.filter((k) => k !== key);
    await Promise.all([this.refreshNotes(), this.refreshActions()]);
    if (this.activeKey === key) this.back();
    this.flash('Deleted permanently', 'red');
  }

  async setLabel(id: number, labelId: number | null): Promise<void> {
    await api.setNoteLabel(id, labelId);
    await this.refreshNotes();
  }

  // --- actions ------------------------------------------------------------

  async toggleAction(id: number, done: boolean): Promise<void> {
    await api.setActionDone(id, done);
    await this.refreshActions();
    await this.refreshNotes();
  }

  async setActionProject(id: number, projectId: number | null): Promise<void> {
    await api.setActionProject(id, projectId);
    await this.refreshActions();
  }

  /** Drop a card into a column. `ids` is that column's order after the move. */
  async moveAction(id: number, stageId: number, ids: number[]): Promise<void> {
    await api.moveAction(id, stageId, ids);
    await Promise.all([this.refreshActions(), this.refreshNotes()]);
  }

  async setActionText(id: number, text: string): Promise<void> {
    await api.setActionText(id, text);
    await this.refreshActions();
  }

  async setActionNotes(id: number, notes: string): Promise<void> {
    await api.setActionNotes(id, notes);
    await this.refreshActions();
  }

  async setActionDue(id: number, due: string | null): Promise<void> {
    await api.setActionDue(id, due);
    await this.refreshActions();
  }

  async setActionStart(id: number, start: string | null): Promise<void> {
    await api.setActionStart(id, start);
    await this.refreshActions();
  }

  /**
   * A dragged bar, committed. Both dates in one write, and one offered undo.
   *
   * A drag overwrites two dates at once and a slipped pointer is a normal way
   * to use a mouse, so the gesture that is easiest to fumble is the one that
   * has to be cheapest to take back. The undo is the same call with the
   * previous span, which is why it needs nothing stored anywhere.
   */
  async setActionSpan(
    id: number,
    start: string | null,
    due: string | null,
    label = 'Moved'
  ): Promise<void> {
    const before = this.actions.find((a) => a.id === id);
    if (!before) return;
    if (before.start_date === start && before.due_date === due) return;
    const prevStart = before.start_date;
    const prevDue = before.due_date;

    await api.setActionSpan(id, start, due);
    await this.refreshActions();
    this.flash(label, 'green', async () => {
      await api.setActionSpan(id, prevStart, prevDue);
      await this.refreshActions();
    });
  }

  /**
   * A bar dropped into another project group, or moved within its own.
   *
   * `ids` is the destination group's full order after the drop. The project
   * write and the renumber share one transaction, so a group can never be left
   * holding a row it has no position for.
   */
  async moveActionProject(
    id: number,
    projectId: number | null,
    ids: number[]
  ): Promise<void> {
    const before = this.actions.find((a) => a.id === id);
    const prevProject = before ? (before.project_id ?? null) : null;
    const prevOrder = this.groupOrder(prevProject);

    await api.moveActionProject(id, projectId, ids);
    await this.refreshActions();

    if (prevProject !== projectId) {
      const name = projectId === null ? 'No project' : this.projectById(projectId)?.name;
      this.flash(`Moved to ${name}`, 'green', async () => {
        await api.moveActionProject(id, prevProject, prevOrder);
        await this.refreshActions();
      });
    }
  }

  /**
   * One dragged bar, committed whole.
   *
   * A single drag on the chart can move a row through time *and* into another
   * project at once, and those are two different writes. They are issued
   * together and reported once: two toasts stacking for one gesture is the
   * app narrating its own implementation. The undo reverses whichever halves
   * actually changed, in the order that cannot leave a row half-restored.
   */
  async commitTimelineDrag(opts: {
    id: number;
    start: string | null;
    due: string | null;
    projectId: number | null;
    /** The destination group's full order after the drop. */
    ids: number[];
  }): Promise<void> {
    const before = this.actions.find((a) => a.id === opts.id);
    if (!before) return;

    const prevStart = before.start_date;
    const prevDue = before.due_date;
    const prevProject = this.timelineGroupOf(before);
    const prevOrder = this.groupOrder(prevProject);

    const spanChanged = prevStart !== opts.start || prevDue !== opts.due;
    const placeChanged =
      prevProject !== opts.projectId ||
      this.groupOrder(opts.projectId).join() !== opts.ids.join();
    if (!spanChanged && !placeChanged) return;

    if (spanChanged) await api.setActionSpan(opts.id, opts.start, opts.due);
    if (placeChanged) await api.moveActionProject(opts.id, opts.projectId, opts.ids);
    await this.refreshActions();

    const moved = prevProject !== opts.projectId;
    const name = opts.projectId === null ? 'No project' : this.projectById(opts.projectId)?.name;
    const label = moved ? `Moved to ${name}` : spanChanged ? 'Rescheduled' : 'Reordered';

    this.flash(label, 'green', async () => {
      if (placeChanged) await api.moveActionProject(opts.id, prevProject, prevOrder);
      if (spanChanged) await api.setActionSpan(opts.id, prevStart, prevDue);
      await this.refreshActions();
    });
  }

  // --- attachments --------------------------------------------------------
  //
  // Held for the open card only. The board never needs the rows themselves —
  // `attach_count` comes down with the action — so nothing is cached beyond
  // the card the user is looking at.

  attachments = $state<Attachment[]>([]);
  attachBusy = $state(false);

  async loadAttachments(actionId: number | null): Promise<void> {
    if (actionId === null) {
      this.attachments = [];
      return;
    }
    this.attachments = await api.listAttachments(actionId);
  }

  /** One file from the clipboard or the picker. Refreshes the actions so the
      clip on the card's face agrees with the panel. */
  private async afterAttach(actionId: number): Promise<void> {
    await Promise.all([this.loadAttachments(actionId), this.refreshActions()]);
  }

  async attachBytes(actionId: number, name: string, bytes: number[]): Promise<void> {
    this.attachBusy = true;
    try {
      await api.saveAttachment(actionId, name, bytes);
      await this.afterAttach(actionId);
    } catch (e) {
      this.flash(String(e), 'red');
    } finally {
      this.attachBusy = false;
    }
  }

  /** Files that came from a place keep their place: this stores the path and
      never the bytes. */
  async linkPaths(actionId: number, paths: string[]): Promise<void> {
    if (!paths.length) return;
    this.attachBusy = true;
    try {
      await api.linkPaths(actionId, paths);
      await this.afterAttach(actionId);
    } catch (e) {
      this.flash(String(e), 'red');
    } finally {
      this.attachBusy = false;
    }
  }

  /** Copying a file in Explorer puts its path on the clipboard, so a paste can
      attach a link. Returns true when it did, so a caller can fall back to the
      clipboard's own bytes for a screenshot, which has no place to point at. */
  async pasteAsLink(actionId: number): Promise<boolean> {
    const paths = await api.clipboardFilePaths().catch(() => [] as string[]);
    if (!paths.length) return false;
    await this.linkPaths(actionId, paths);
    return true;
  }

  /** Detaching drops the link. The bytes stay: another action may address the
      same hash, and this store has never deleted a file it was given. */
  async detach(id: number, actionId: number): Promise<void> {
    await api.deleteAttachment(id);
    await this.afterAttach(actionId);
  }

  async openAttachment(id: number): Promise<void> {
    try {
      await api.openAttachment(id);
    } catch (e) {
      this.flash(String(e), 'amber');
    }
  }

  async revealAttachment(id: number): Promise<void> {
    try {
      await api.revealAttachment(id);
    } catch (e) {
      this.flash(String(e), 'amber');
    }
  }

  async deleteAction(id: number): Promise<void> {
    await api.deleteAction(id);
    if (this.openCard === id) this.openCard = null;
    await Promise.all([this.refreshActions(), this.refreshNotes()]);
    this.flash('Deleted permanently', 'red');
  }

  // --- board columns ------------------------------------------------------

  async renameStage(id: number, name: string): Promise<void> {
    const s = this.stages.find((x) => x.id === id);
    if (!s || !name.trim() || name === s.name) return;
    await api.updateStage(id, name.trim(), s.hidden);
    await this.refreshBoard();
  }

  /** Shift a column one place. Written against the full stage list, not the
      visible one, so a hidden column between two visible ones does not make a
      move silently do nothing. */
  async moveStage(id: number, delta: -1 | 1): Promise<void> {
    const ids = this.stages.map((s) => s.id);
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    await this.reorderStages(ids);
  }

  async reorderStages(ids: number[]): Promise<void> {
    await api.reorderStages(ids);
    await this.refreshBoard();
  }

  async deleteStage(id: number): Promise<void> {
    try {
      const moved = await api.deleteStage(id);
      await Promise.all([this.refreshBoard(), this.refreshActions()]);
      this.flash(
        moved > 0
          ? `Column deleted — ${moved} card${moved === 1 ? '' : 's'} moved`
          : 'Column deleted',
        'red'
      );
    } catch (e) {
      this.flash(String(e), 'amber');
    }
  }

  async addStage(name: string): Promise<void> {
    if (!name.trim()) return;
    await api.createStage(name.trim());
    await this.refreshBoard();
  }

  reveal(noteId: number, anchorId: string | null): void {
    this.openNote(noteId);
    if (anchorId) this.revealAnchor = { noteId, anchorId };
  }

  // --- transient ----------------------------------------------------------

  private toastTimer: number | undefined;

  /** An undo lives exactly as long as the toast offering it. Nothing is queued
      and nothing stacks: the offer is on screen or it is gone. */
  flash(
    text: string,
    tone: 'green' | 'amber' | 'red' = 'green',
    undo?: () => void | Promise<void>
  ): void {
    this.toast = {
      text,
      tone,
      undo: undo
        ? () => {
            this.toast = null;
            clearTimeout(this.toastTimer);
            void undo();
          }
        : undefined
    };
    clearTimeout(this.toastTimer);
    // An offer to reverse something needs longer to read and reach than a
    // statement that it happened.
    const life = undo ? 5000 : 2400;
    this.toastTimer = setTimeout(() => (this.toast = null), life) as unknown as number;
  }
}

/**
 * The excerpt the backend ships is the first 160 characters of the plaintext
 * mirror, and a note whose body opens with its own heading therefore repeats
 * its title in the row beneath it. Drop that leading repeat so the excerpt
 * carries the second line — the part the title does not already say.
 */
export function excerptOf(n: { title: string; excerpt: string | null }): string {
  const text = (n.excerpt ?? '').trim();
  const title = n.title.trim();
  if (!title || !text.toLowerCase().startsWith(title.toLowerCase())) return text;
  return text.slice(title.length).replace(/^[\s—–:.\-]+/, '');
}

export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const store = new Store();
