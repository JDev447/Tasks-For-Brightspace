(() => {
  "use strict";

  if (window.top !== window || document.getElementById("tfb-host")) return;

  const COLORS = ["#2563eb", "#e11d48", "#16a34a", "#9333ea", "#ea580c", "#0891b2"];
  const state = {
    courses: [],
    tasks: [],
    range: 7,
    offset: 0,
    collapsed: false,
    selectedCourseId: "all",
    animateRings: false,
    animateManualRing: false,
    ringAnimationFrom: new Map(),
    spinRefresh: false,
    sectionsExpanded: { unfinished: true, completed: false },
    loading: false,
    error: "",
    lastSync: null,
    manualDone: new Set()
  };

  const host = document.createElement("aside");
  host.id = "tfb-host";
  host.setAttribute("aria-label", "Tasks for Brightspace");
  const root = host.attachShadow({ mode: "open" });

  // Keep the CSS inside the shadow root as text. A <link> to an unpacked
  // extension resource can become invalid if the extension is reloaded while
  // Brightspace remains open, leaving the widget as unstyled HTML.
  const style = document.createElement("style");
  root.append(style);

  const app = document.createElement("div");
  app.hidden = true;
  root.append(app);

  const stylesReady = (async () => {
    try {
      const response = await fetch(chrome.runtime.getURL("src/panel.css"), { cache: "no-store" });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      style.textContent = await response.text();
      return true;
    } catch (error) {
      console.warn("Tasks for Brightspace could not load its styles:", error);
      return false;
    }
  })();

  function composedParent(element) {
    if (element.parentElement) return element.parentElement;
    const tree = element.getRootNode?.();
    return tree instanceof ShadowRoot ? tree.host : null;
  }

  function collectDeep(rootNode, selector, output = []) {
    rootNode.querySelectorAll?.(selector).forEach((element) => output.push(element));
    rootNode.querySelectorAll?.("*").forEach((element) => {
      if (element.shadowRoot) collectDeep(element.shadowRoot, selector, output);
    });
    return output;
  }

  function widgetForTitle(titleElement) {
    let current = titleElement;
    while (current && current !== document.body) {
      const tag = current.tagName?.toLowerCase() || "";
      const classes = String(current.className || "").toLowerCase();
      const classTokens = classes.split(/\s+/);
      const isWidgetContainer = tag === "d2l-widget"
        || (tag.endsWith("-widget") && !tag.includes("header"))
        || classTokens.includes("d2l-widget")
        || classes.includes("widget-container")
        || classes.includes("widget-wrapper");
      if (isWidgetContainer || current.getAttribute?.("role") === "region") {
        return current;
      }
      current = composedParent(current);
    }
    return null;
  }

  function findTitleByText(label) {
    const titleSelectors = "h1,h2,h3,h4,[slot*='title'],[class*='title'],[class*='heading']";
    const titles = collectDeep(document, titleSelectors);
    const wanted = label.trim().toLowerCase();
    return titles.find((element) => element.textContent?.trim().toLowerCase() === wanted) || null;
  }

  function findWidgetByTitle(label) {
    const title = findTitleByText(label);
    return title ? widgetForTitle(title) : null;
  }

  function alignWithCoursesWidget() {
    const alignmentTitle = findTitleByText("My Courses") || findTitleByText("Announcements");
    const alignmentWidget = alignmentTitle ? widgetForTitle(alignmentTitle) : null;
    if (!host.isConnected) return;
    host.style.marginTop = "0px";
    if (!alignmentTitle) return;
    requestAnimationFrame(() => {
      const targetTop = alignmentWidget
        ? alignmentWidget.getBoundingClientRect().top
        : alignmentTitle.getBoundingClientRect().top - 42;
      const delta = targetTop - host.getBoundingClientRect().top;
      host.style.marginTop = delta > 0 && delta < 240 ? `${Math.round(delta)}px` : "0px";
    });
  }

  function mountHost() {
    // Calendar stays in Brightspace's narrow/right column on both organization
    // and course homepages. Announcements can move to the wide/left column.
    const calendar = findWidgetByTitle("Calendar");
    if (calendar?.parentNode) {
      const rightColumn = calendar.parentNode;
      if (host.parentNode !== rightColumn || rightColumn.firstElementChild !== host) {
        rightColumn.insertBefore(host, rightColumn.firstChild);
      }
      host.dataset.placement = "right-column";
      alignWithCoursesWidget();
      return true;
    }

    const columns = collectDeep(document, ".d2l-homepage-column, [class*='homepage-column'], [class*='homepage_col']")
      .filter((column) => {
        const rect = column.getBoundingClientRect();
        return rect.width > 220 && rect.height > 0;
      })
      .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
    const rightColumn = columns[0];
    if (rightColumn && !host.isConnected) {
      rightColumn.prepend(host);
      host.dataset.placement = "right-column-fallback";
      alignWithCoursesWidget();
      return true;
    }
    return false;
  }

  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  function storageSet(value) {
    return new Promise((resolve) => chrome.storage.local.set(value, resolve));
  }

  function escapeHtml(value = "") {
    const el = document.createElement("span");
    el.textContent = String(value);
    return el.innerHTML;
  }

  function compareVersions(a, b) {
    const aa = String(a).split(".").map(Number);
    const bb = String(b).split(".").map(Number);
    return (aa[0] - bb[0]) || (aa[1] - bb[1]);
  }

  function productVersions(payload, product) {
    const entries = Array.isArray(payload) ? payload : [payload];
    const entry = entries.find((item) =>
      String(item.ProductCode || item.Product || item.Name || "").toLowerCase() === product
    );
    if (!entry) return [];
    const raw = entry.Versions || entry.SupportedVersions || entry.VersionList || [];
    return raw
      .map((v) => typeof v === "string" ? v : v.Version || v.Value)
      .filter((v) => /^\d+\.\d+$/.test(String(v)));
  }

  async function json(url) {
    const response = await fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const type = response.headers.get("content-type") || "";
    if (!type.includes("json")) throw new Error("Brightspace returned a sign-in page instead of data");
    return response.json();
  }

  async function allPages(url) {
    const output = [];
    let next = url;
    for (let page = 0; next && page < 20; page += 1) {
      const data = await json(next);
      const objects = data.Objects || data.Items || (Array.isArray(data) ? data : []);
      output.push(...objects);
      const bookmark = data.PagingInfo?.Bookmark || data.PagingInfo?.bookmark;
      const hasMore = data.PagingInfo?.HasMoreItems ?? data.PagingInfo?.hasMoreItems;
      if (!hasMore || !bookmark) break;
      const parsed = new URL(next, location.origin);
      parsed.searchParams.set("bookmark", bookmark);
      next = parsed.toString();
    }
    return output;
  }

  function weekWindow() {
    const now = new Date();
    const day = (now.getDay() + 6) % 7;
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - day + state.offset * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + state.range);
    end.setMilliseconds(-1);
    return { start, end };
  }

  function isCourseEnrollment(item) {
    const org = item.OrgUnit || item.orgUnit || {};
    const type = org.Type || org.type || {};
    const id = Number(type.Id ?? type.Identifier ?? item.OrgUnitTypeId);
    const name = String(type.Name || type.Code || "").toLowerCase();
    return id === 3 || name.includes("course offering");
  }

  function normalizeCourse(item, index) {
    const org = item.OrgUnit || item.orgUnit || item;
    return {
      id: String(org.Id ?? org.Identifier ?? item.OrgUnitId),
      name: org.Name || org.Code || `Course ${index + 1}`,
      code: org.Code || "",
      color: COLORS[index % COLORS.length]
    };
  }

  function normalizeTask(item, courseMap) {
    const courseId = String(item.OrgUnitId);
    const due = item.DueDate || item.EndDate || item.StartDate;
    const id = `${courseId}:${item.ItemId}`;
    return {
      id,
      sourceId: String(item.ItemId),
      courseId,
      course: courseMap.get(courseId)?.name || "Brightspace",
      color: courseMap.get(courseId)?.color || COLORS[0],
      title: item.ItemName || "Untitled activity",
      url: item.ItemUrl ? new URL(item.ItemUrl, location.origin).href : `${location.origin}/d2l/home/${courseId}`,
      due: due ? new Date(due) : null,
      completed: Boolean(item.DateCompleted) || state.manualDone.has(id),
      automatic: Boolean(item.DateCompleted),
      exempt: Boolean(item.IsExempt)
    };
  }

  async function loadData({ spin = false } = {}) {
    const minimumLoadingUntil = spin ? Date.now() + 600 : 0;
    state.loading = true;
    state.animateRings = false;
    state.spinRefresh = spin;
    state.error = "";
    render();
    let succeeded = false;
    try {
      const versions = await json("/d2l/api/versions/");
      const lpVersions = productVersions(versions, "lp").sort(compareVersions);
      const leVersions = productVersions(versions, "le").sort(compareVersions);
      const lp = lpVersions.at(-1) || "1.43";
      const le = leVersions.at(-1) || "1.75";

      const enrollmentData = await allPages(`/d2l/api/lp/${lp}/enrollments/myenrollments/`);
      let courseItems = enrollmentData.filter(isCourseEnrollment);
      if (!courseItems.length) courseItems = enrollmentData.filter((item) => item.OrgUnit?.Id);
      state.courses = courseItems.slice(0, 100).map(normalizeCourse);
      const courseMap = new Map(state.courses.map((course) => [course.id, course]));
      const ids = state.courses.map((course) => course.id).join(",");
      if (!ids) throw new Error("No active course enrollments were found");

      const { start, end } = weekWindow();
      const params = new URLSearchParams({
        orgUnitIdsCSV: ids,
        startDateTime: start.toISOString(),
        endDateTime: end.toISOString()
      });
      const taskData = await allPages(`/d2l/api/le/${le}/content/myItems/?${params}`);
      state.tasks = taskData
        .map((item) => normalizeTask(item, courseMap))
        // Brightspace filters scheduled items by any scheduled date. An item can
        // start this week but be due next week, so enforce the visible window on
        // the actual due date after receiving the response.
        .filter((task) => !task.exempt && task.due && task.due >= start && task.due <= end)
        .sort((a, b) => a.due - b.due);
      state.lastSync = new Date();
      succeeded = true;
    } catch (error) {
      console.warn("Tasks for Brightspace:", error);
      state.error = error.message || "Could not read Brightspace tasks";
    } finally {
      const wait = minimumLoadingUntil - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      state.loading = false;
      state.animateRings = succeeded;
      state.spinRefresh = false;
      render();
      state.animateRings = false;
    }
  }

  function progressByCourse() {
    return state.courses.map((course) => {
      const tasks = state.tasks.filter((task) => task.courseId === course.id);
      const done = tasks.filter((task) => task.completed).length;
      return { ...course, total: tasks.length, done, ratio: tasks.length ? done / tasks.length : 0 };
    }).filter((course) => course.total > 0);
  }

  function ring(course, index) {
    const radius = 50 - index * 7;
    const length = 2 * Math.PI * radius;
    const offset = state.loading ? length : length * (1 - course.ratio);
    const previousRatio = state.ringAnimationFrom.get(course.id);
    const fromOffset = previousRatio === undefined ? offset : length * (1 - previousRatio);
    const selected = state.selectedCourseId === course.id;
    const muted = state.selectedCourseId !== "all" && !selected;
    return `<g class="ring-course ${selected ? "is-selected" : ""} ${muted ? "is-muted" : ""}"
      data-course-id="${escapeHtml(course.id)}" role="button" tabindex="0"
      aria-label="Show ${escapeHtml(course.name)} tasks, ${course.done} of ${course.total} complete">
      <circle class="ring-track" cx="60" cy="60" r="${radius}" />
      <circle class="ring-progress" cx="60" cy="60" r="${radius}"
        style="--ring-length:${length};--ring-from-offset:${fromOffset};--ring-offset:${offset}"
        stroke="${course.color}" stroke-dasharray="${length}" stroke-dashoffset="${offset}" />
    </g>`;
  }

  function formatRange() {
    const { start, end } = weekWindow();
    const opts = { month: "short", day: "numeric" };
    return `${start.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, opts)}`;
  }

  function formatDue(date) {
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    const dateText = sameDay ? "Today" : date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    return `${dateText}, ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }

  function taskRow(task, index = 0) {
    const filteredOut = state.selectedCourseId !== "all" && task.courseId !== state.selectedCourseId;
    const checkAction = task.automatic ? "Completed automatically by Brightspace" : task.completed ? "Uncheck task" : "Check off task";
    return `<li class="task ${task.completed ? "is-done" : ""} ${filteredOut ? "is-filtered-out" : ""}"
      data-id="${escapeHtml(task.id)}" data-course-id="${escapeHtml(task.courseId)}" aria-hidden="${filteredOut}">
      <button class="check" type="button" ${task.automatic ? "disabled" : ""} title="${escapeHtml(checkAction)}" aria-label="${escapeHtml(checkAction)}" aria-pressed="${task.completed}">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 4 4 8-9" /></svg>
      </button>
      <a href="${escapeHtml(task.url)}" class="task-link" title="Open ${escapeHtml(task.title)} in Brightspace">
        <span class="task-title">${escapeHtml(task.title)}</span>
        <span class="task-meta"><i style="--course:${task.color}"></i>${escapeHtml(task.course)} · ${escapeHtml(formatDue(task.due))}</span>
      </a>
    </li>`;
  }

  function render() {
    host.classList.toggle("tfb-collapsed", state.collapsed);
    const courses = progressByCourse();
    if (state.selectedCourseId !== "all" && !courses.some((course) => course.id === state.selectedCourseId)) {
      state.selectedCourseId = "all";
    }
    const visibleTasks = state.selectedCourseId === "all"
      ? state.tasks
      : state.tasks.filter((task) => task.courseId === state.selectedCourseId);
    const done = visibleTasks.filter((task) => task.completed);
    const open = visibleTasks.filter((task) => !task.completed);
    const totalRatio = visibleTasks.length ? Math.round((done.length / visibleTasks.length) * 100) : 0;
    const rings = courses.map(ring).join("");
    const courseOptions = courses.map((course) => `<option value="${escapeHtml(course.id)}" ${state.selectedCourseId === course.id ? "selected" : ""}>${escapeHtml(course.name)} (${course.done}/${course.total})</option>`).join("");
    const allOpen = state.tasks.filter((task) => !task.completed);
    const allDone = state.tasks.filter((task) => task.completed);
    const centerContent = state.loading
      ? `<div class="ring-loading" role="status"><span class="spinner"></span><small>Loading assignments</small></div>`
      : `<strong>${totalRatio}%</strong><span>${done.length}/${visibleTasks.length} complete</span>`;
    const content = state.loading
      ? `<div class="status updating">Updating task list…</div>`
      : state.error
        ? `<div class="error"><strong>Couldn’t load tasks</strong><span>${escapeHtml(state.error)}</span><button class="retry" type="button">Try again</button></div>`
        : `<section class="task-section unfinished-section ${state.sectionsExpanded.unfinished ? "is-expanded" : ""}" data-section="unfinished">
            <button class="section-toggle" type="button" aria-expanded="${state.sectionsExpanded.unfinished}">
              <span class="chevron-icon ${state.sectionsExpanded.unfinished ? "is-expanded" : ""}">›</span><h2>Unfinished</h2><span class="section-count unfinished-count">${open.length}</span>
            </button>
            <div class="section-collapse"><div><ul class="task-list unfinished-list">
              ${allOpen.map(taskRow).join("")}
              <li class="empty section-empty unfinished-empty ${open.length ? "" : "is-visible"}">All clear for this period.</li>
            </ul></div></div>
          </section>
          <section class="task-section completed-section ${state.sectionsExpanded.completed ? "is-expanded" : ""}" data-section="completed">
            <button class="section-toggle" type="button" aria-expanded="${state.sectionsExpanded.completed}">
              <span class="chevron-icon ${state.sectionsExpanded.completed ? "is-expanded" : ""}">›</span><h2>Completed</h2><span class="section-count completed-count">${done.length}</span>
            </button>
            <div class="section-collapse"><div><ul class="task-list done-list">
              ${allDone.map(taskRow).join("")}
              <li class="empty section-empty completed-empty ${done.length ? "" : "is-visible"}">No completed tasks for this period.</li>
            </ul></div></div>
          </section>`;

    app.innerHTML = `<section class="panel ${state.collapsed ? "is-collapsed" : ""}">
      <header>
        <div class="brand"><span class="brand-mark"></span><div><h1>Tasks</h1><p>for Brightspace</p></div></div>
        <div class="header-actions"><button class="refresh ${state.spinRefresh ? "is-spinning" : ""}" type="button" title="Refresh" aria-label="Refresh tasks">↻</button><button class="widget-toggle chevron" type="button" title="${state.collapsed ? "Expand" : "Collapse"}" aria-label="${state.collapsed ? "Expand" : "Collapse"} task widget" aria-expanded="${!state.collapsed}"><span class="chevron-icon ${state.collapsed ? "" : "is-expanded"}">›</span></button></div>
      </header>
      <div class="widget-collapse"><div class="widget-collapse-inner">
      <div class="period">
        <button class="previous" type="button" aria-label="Previous week">‹</button>
        <button class="current-period" type="button" title="Return to this week"><strong>${escapeHtml(formatRange())}</strong><span>${state.offset ? "Return to this week" : "This week"}</span></button>
        <button class="next" type="button" aria-label="Next week">›</button>
      </div>
      <label class="course-picker">
        <span>Course</span>
        <select class="course-filter" aria-label="Filter tasks by course">
          <option value="all" ${state.selectedCourseId === "all" ? "selected" : ""}>All courses</option>
          ${courseOptions}
        </select>
      </label>
      <div class="overview">
        <svg class="rings ${state.animateRings ? "animate-rings" : ""} ${state.animateManualRing ? "animate-manual-ring" : ""}" viewBox="0 0 120 120" role="group" aria-label="Course progress rings. Select a ring to filter tasks.">
          ${rings}
        </svg>
        <div class="ring-label">${centerContent}</div>
      </div>
      <div class="content">${content}</div>
      <footer>${state.lastSync ? `Updated ${state.lastSync.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : "Stored only in this browser"}</footer>
      </div></div>
    </section>`;
    bind();
  }

  function applyCourseFilter(courseId) {
    state.selectedCourseId = courseId;
    const visible = courseId === "all" ? state.tasks : state.tasks.filter((task) => task.courseId === courseId);
    const openCount = visible.filter((task) => !task.completed).length;
    const doneCount = visible.filter((task) => task.completed).length;
    const ratio = visible.length ? Math.round((doneCount / visible.length) * 100) : 0;

    const select = app.querySelector(".course-filter");
    if (select) select.value = courseId;
    app.querySelectorAll(".ring-course").forEach((ringElement) => {
      const selected = ringElement.dataset.courseId === courseId;
      ringElement.classList.toggle("is-selected", selected);
      ringElement.classList.toggle("is-muted", courseId !== "all" && !selected);
    });
    app.querySelectorAll(".task").forEach((taskElement) => {
      const hidden = courseId !== "all" && taskElement.dataset.courseId !== courseId;
      taskElement.classList.toggle("is-filtered-out", hidden);
      taskElement.setAttribute("aria-hidden", String(hidden));
    });

    const unfinishedCount = app.querySelector(".unfinished-count");
    const completedCount = app.querySelector(".completed-count");
    if (unfinishedCount) unfinishedCount.textContent = String(openCount);
    if (completedCount) completedCount.textContent = String(doneCount);
    app.querySelector(".unfinished-empty")?.classList.toggle("is-visible", openCount === 0);
    app.querySelector(".completed-empty")?.classList.toggle("is-visible", doneCount === 0);

    const label = app.querySelector(".ring-label");
    if (label && !state.loading) {
      label.innerHTML = `<strong>${ratio}%</strong><span>${doneCount}/${visible.length} complete</span>`;
      label.classList.remove("is-changing");
      void label.offsetWidth;
      label.classList.add("is-changing");
    }
    requestAnimationFrame(sizeTaskLists);
  }

  function sizeTaskLists() {
    app.querySelectorAll(".task-list").forEach((list) => {
      const visibleRows = [...list.querySelectorAll(".task")]
        .filter((row) => !row.classList.contains("is-filtered-out"));
      const scrollable = visibleRows.length > 4;
      list.classList.toggle("is-scrollable", scrollable);
      if (!scrollable) {
        list.style.maxHeight = "none";
        return;
      }
      const fourRowsHeight = visibleRows
        .slice(0, 4)
        .reduce((height, row) => height + Math.max(row.scrollHeight, 52), 0);
      list.style.maxHeight = `${fourRowsHeight + 6}px`;
    });
  }

  function bind() {
    app.querySelector(".widget-toggle")?.addEventListener("click", () => {
      const panel = app.querySelector(".panel");
      const button = app.querySelector(".widget-toggle");
      const expanded = panel.classList.contains("is-collapsed");
      state.collapsed = !expanded;
      panel.classList.toggle("is-collapsed", !expanded);
      host.classList.toggle("tfb-collapsed", !expanded);
      button.setAttribute("aria-expanded", String(expanded));
      button.setAttribute("aria-label", `${expanded ? "Collapse" : "Expand"} task widget`);
      button.title = expanded ? "Collapse" : "Expand";
      button.querySelector(".chevron-icon")?.classList.toggle("is-expanded", expanded);
      storageSet({ collapsed: !expanded });
      if (expanded && !state.lastSync && !state.loading) {
        setTimeout(() => loadData(), 320);
      }
    });
    app.querySelector(".refresh")?.addEventListener("click", () => loadData({ spin: true }));
    app.querySelector(".retry")?.addEventListener("click", loadData);
    app.querySelector(".previous")?.addEventListener("click", () => { state.offset -= 1; loadData(); });
    app.querySelector(".next")?.addEventListener("click", () => { state.offset += 1; loadData(); });
    app.querySelector(".current-period")?.addEventListener("click", () => {
      if (state.offset) { state.offset = 0; loadData(); }
    });
    app.querySelector(".course-filter")?.addEventListener("change", (event) => {
      applyCourseFilter(event.target.value);
    });
    const selectRing = (courseId) => {
      applyCourseFilter(state.selectedCourseId === courseId ? "all" : courseId);
    };
    app.querySelectorAll(".ring-course").forEach((ringElement) => {
      ringElement.addEventListener("click", () => selectRing(ringElement.dataset.courseId));
      ringElement.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectRing(ringElement.dataset.courseId);
        }
      });
    });
    app.querySelectorAll(".section-toggle").forEach((button) => button.addEventListener("click", () => {
      const section = button.closest(".task-section");
      const name = section.dataset.section;
      const expanded = !section.classList.contains("is-expanded");
      section.classList.toggle("is-expanded", expanded);
      button.setAttribute("aria-expanded", String(expanded));
      button.querySelector(".chevron-icon")?.classList.toggle("is-expanded", expanded);
      state.sectionsExpanded[name] = expanded;
      requestAnimationFrame(sizeTaskLists);
    }));
    app.querySelectorAll(".check").forEach((button) => button.addEventListener("click", async () => {
      const id = button.closest(".task").dataset.id;
      const task = state.tasks.find((item) => item.id === id);
      if (!task || task.automatic) return;
      const courseTasks = state.tasks.filter((item) => item.courseId === task.courseId);
      const previouslyDone = courseTasks.filter((item) => item.completed).length;
      const previousRatio = courseTasks.length ? previouslyDone / courseTasks.length : 0;
      if (state.manualDone.has(id)) state.manualDone.delete(id); else state.manualDone.add(id);
      task.completed = state.manualDone.has(id);
      await storageSet({ manualDone: [...state.manualDone] });
      state.ringAnimationFrom = new Map([[task.courseId, previousRatio]]);
      state.animateManualRing = true;
      render();
      state.animateManualRing = false;
      state.ringAnimationFrom = new Map();
    }));
    requestAnimationFrame(sizeTaskLists);
  }

  async function init() {
    const styled = await stylesReady;
    if (!styled) return;
    app.hidden = false;
    const saved = await storageGet(["collapsed", "manualDone"]);
    state.collapsed = Boolean(saved.collapsed);
    state.manualDone = new Set(saved.manualDone || []);
    render();
    mountHost();
    let mountAttempts = 0;
    const mountTimer = setInterval(() => {
      mountAttempts += 1;
      if (mountHost() || mountAttempts > 60) clearInterval(mountTimer);
    }, 500);
    new MutationObserver(() => {
      if (!host.isConnected) mountHost();
    }).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("resize", alignWithCoursesWidget);
    if (!state.collapsed) loadData();
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && state.lastSync && Date.now() - state.lastSync > 120000) loadData();
    });
    setInterval(() => { if (!document.hidden && !state.collapsed) loadData(); }, 5 * 60 * 1000);
  }

  init();
})();
