/* Context Engine browser readout. Every number on screen is read from the live index. */
(() => {
  "use strict";
  const $ = (sel, root = document) => root.querySelector(sel);
  const slot = (root, name) => root.querySelector(`[data-slot="${name}"]`);
  const esc = (value) => String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const HUE = { dependency: 28, configuration: 186, rendering: 262, seo: 328, api_dependency: 150,
    cache: 44, build: 210, security: 4, repository_profile: 288, technical_debt: 14,
    performance_observation: 96, business_capability: 74, design_system: 240 };

  async function api(path) {
    const response = await fetch(path, { headers: { accept: "application/json" } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
    return payload;
  }

  const state = { projects: [], current: null, view: null };

  /* ---------------- rail ---------------- */
  function renderRail() {
    const nav = $("#projects");
    nav.innerHTML = "";
    for (const project of state.projects) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "project";
      button.setAttribute("aria-current", String(project.name === state.current));
      const freshness = project.freshness ? project.freshness.state : "unknown";
      button.innerHTML =
        `<span class="pname">${esc(project.name)}</span>` +
        `<span class="pmeta"><span><i class="dot ${esc(freshness)}"></i>${esc(freshness)}</span>` +
        `<span>${project.facts} facts</span><span>${project.routes} routes</span></span>`;
      button.addEventListener("click", () => select(project.name));
      nav.appendChild(button);
    }
  }

  /* ---------------- metrics ---------------- */
  function metric(key, value, note, tone) {
    return `<div class="metric"><div class="k">${esc(key)}</div>` +
      `<div class="v${tone ? " " + tone : ""}">${esc(value)}</div>` +
      `<div class="n">${esc(note)}</div></div>`;
  }

  function renderMetrics(root, project, projection) {
    const duplication = project.duplicationRatio ?? 0;
    const coverage = project.evidenceCoverage ?? 0;
    slot(root, "metrics").innerHTML = [
      metric("stored facts", project.facts, `${project.vectors ?? 0} embedded`),
      metric("routes", project.routes, "structured, not searched"),
      metric("duplication", `${(duplication * 100).toFixed(1)}%`,
        "one thing, one record", duplication <= 0.05 ? "good" : "warn"),
      metric("evidence coverage", `${(coverage * 100).toFixed(0)}%`,
        "facts carrying file and line", coverage >= 0.95 ? "good" : "warn"),
      metric("symbol coverage", `${((project.symbolCoverage ?? 0) * 100).toFixed(0)}%`, "pinned to a symbol"),
      metric("config declared, never read", project.unreadConfigKeys ?? 0,
        "dead configuration", (project.unreadConfigKeys ?? 0) === 0 ? "good" : "warn"),
    ].join("");
    slot(root, "pcaNote").innerHTML = projection.explained.length
      ? `first two axes hold <b>${Math.round(projection.explained.slice(0, 2).reduce((a, b) => a + b, 0) * 100)}%</b> of ${projection.dimension}-dim variance`
      : "no embeddings in this index";
  }

  /* ---------------- plot ---------------- */
  function mountPlot(root, projection, repository) {
    const canvas = slot(root, "plot");
    const ctx = canvas.getContext("2d");
    const inspect = slot(root, "inspect");
    const points = projection.points;
    const byId = new Map(points.map((p) => [p.id, p]));
    const types = [...new Set(points.map((p) => p.type))]
      .sort((a, b) => points.filter((p) => p.type === b).length - points.filter((p) => p.type === a).length);
    const active = new Set(types);
    const hueFor = (type) => (typeof HUE[type] === "number" ? HUE[type] : (types.indexOf(type) * 47) % 360);

    let width = 0, height = 0, hover = null, probe = null, links = [], searchHit = null;
    const pad = 42;
    const px = (p) => pad + ((p.x + 1) / 2) * (width - pad * 2);
    const py = (p) => pad + (1 - (p.y + 1) / 2) * (height - pad * 2);
    const radius = (p) => 3 + Math.min(p.evidenceCount, 10) * 0.42;

    const legend = slot(root, "legend");
    legend.innerHTML = "";
    for (const type of types) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chip";
      button.setAttribute("aria-pressed", "true");
      button.style.color = `hsl(${hueFor(type)} 58% var(--dot-l,46%))`;
      button.innerHTML = `<i></i>${esc(type.replace(/_/g, " "))} <b>${points.filter((p) => p.type === type).length}</b>`;
      button.addEventListener("click", () => {
        active.has(type) ? active.delete(type) : active.add(type);
        button.setAttribute("aria-pressed", String(active.has(type)));
        shown();
        draw();
      });
      legend.appendChild(button);
    }
    const shown = () => {
      slot(root, "shown").innerHTML = `<b>${points.filter((p) => active.has(p.type)).length}</b> of ${points.length} facts shown`;
    };

    function draw() {
      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = css("--plot-grid");
      ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i += 1) {
        const x = pad + (i / 4) * (width - pad * 2), y = pad + (i / 4) * (height - pad * 2);
        ctx.beginPath(); ctx.moveTo(x, pad); ctx.lineTo(x, height - pad); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(width - pad, y); ctx.stroke();
      }
      ctx.fillStyle = css("--ink-3");
      ctx.font = '10px "IBM Plex Mono",monospace';
      ctx.fillText("PC1", width - pad - 24, height - pad + 17);
      ctx.save(); ctx.translate(pad - 13, pad + 30); ctx.rotate(-Math.PI / 2); ctx.fillText("PC2", 0, 0); ctx.restore();

      const anchor = probe ? byId.get(probe) : null;
      if (anchor && links.length) {
        ctx.setLineDash([3, 4]); ctx.strokeStyle = css("--signal"); ctx.lineWidth = 1.2;
        for (const link of links) {
          const other = byId.get(link.id);
          if (!other || !active.has(other.type)) continue;
          ctx.globalAlpha = 0.25 + Math.max(0, link.similarity) * 0.5;
          ctx.beginPath(); ctx.moveTo(px(anchor), py(anchor)); ctx.lineTo(px(other), py(other)); ctx.stroke();
        }
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      }

      const highlighted = new Set(links.map((l) => l.id));
      for (const point of points) {
        if (!active.has(point.type)) continue;
        const isProbe = probe === point.id;
        const isNear = highlighted.has(point.id);
        const dimmed = (probe || searchHit) && !isProbe && !isNear;
        ctx.globalAlpha = dimmed ? 0.15 : 1;
        ctx.beginPath();
        ctx.arc(px(point), py(point), radius(point) * (isProbe ? 1.7 : 1), 0, Math.PI * 2);
        ctx.fillStyle = `hsl(${hueFor(point.type)} 58% ${css("--dot-l") || "44%"})`;
        ctx.fill();
        if (isProbe || hover === point) {
          ctx.lineWidth = 1.6; ctx.strokeStyle = css("--signal");
          ctx.beginPath(); ctx.arc(px(point), py(point), radius(point) * (isProbe ? 1.7 : 1) + 4.5, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(devicePixelRatio || 1, 2);
      width = rect.width; height = rect.height;
      canvas.width = width * ratio; canvas.height = height * ratio;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw();
    }

    function pick(event) {
      const rect = canvas.getBoundingClientRect();
      const mx = event.clientX - rect.left, my = event.clientY - rect.top;
      let best = null, distance = 1e9;
      for (const point of points) {
        if (!active.has(point.type)) continue;
        const d = Math.hypot(px(point) - mx, py(point) - my);
        if (d < distance) { distance = d; best = point; }
      }
      return distance < 15 ? best : null;
    }

    function linkRows(title) {
      if (!links.length) return "";
      return `<div class="eyebrow" style="margin-top:13px">${esc(title)}</div><div class="knn">` +
        links.map((link) => {
          const point = byId.get(link.id);
          const label = point ? point.subject : link.subject || `#${link.id}`;
          return `<div class="knn-row"><span>${esc(String(label).slice(0, 46))}</span>` +
            `<span class="s">${link.similarity.toFixed(3)}</span>` +
            `<span class="bar"><span style="width:${Math.max(2, Math.round(Math.max(0, link.similarity) * 100))}%"></span></span></div>`;
        }).join("") + "</div>";
    }

    function render(point) {
      if (!point) {
        inspect.innerHTML = searchHit
          ? `<div class="kind">query</div><div class="subj">${esc(searchHit)}</div>` +
            `<p class="body">Embedded in the browser request and matched against the stored vectors by sqlite-vec.</p>` +
            linkRows("Closest facts")
          : `<p class="hint">Hover a point to read the fact.<br>Click to pull its neighbours from the index.<br>Click empty space to release.</p>`;
        return;
      }
      inspect.innerHTML =
        `<div class="kind">${esc(point.type.replace(/_/g, " "))}</div>` +
        `<div class="subj">${esc(point.subject)}</div>` +
        `<p class="body">${esc(point.content)}</p>` +
        `<div class="cite">${point.file ? esc(point.file) : "no file evidence"} · ${point.evidenceCount} evidence row${point.evidenceCount === 1 ? "" : "s"}</div>` +
        (probe === point.id ? linkRows("Nearest in vector space") : "");
    }

    async function setProbe(point) {
      searchHit = null;
      slot(root, "clearSearch").hidden = true;
      if (!point) { probe = null; links = []; render(null); draw(); return; }
      probe = point.id;
      render(point);
      draw();
      try {
        const payload = await api(`/api/ui/neighbours/${encodeURIComponent(repository)}?id=${point.id}`);
        if (probe !== point.id) return;
        links = payload.neighbours;
        render(point);
        draw();
      } catch { /* leave the fact readable without neighbours */ }
    }

    canvas.addEventListener("mousemove", (event) => {
      const point = pick(event);
      if (point !== hover) { hover = point; if (!probe && !searchHit) render(point); draw(); }
    });
    canvas.addEventListener("mouseleave", () => { hover = null; if (!probe && !searchHit) render(null); draw(); });
    canvas.addEventListener("click", (event) => setProbe(pick(event)));

    const form = slot(root, "searchForm");
    const input = slot(root, "searchInput");
    const clear = slot(root, "clearSearch");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const query = input.value.trim();
      if (query.length < 2) return;
      inspect.innerHTML = `<p class="hint">embedding “${esc(query)}” …</p>`;
      try {
        const payload = await api(`/api/ui/vector-search/${encodeURIComponent(repository)}?q=${encodeURIComponent(query)}`);
        probe = null;
        searchHit = query;
        links = payload.matches;
        clear.hidden = false;
        render(null);
        draw();
      } catch (error) {
        inspect.innerHTML = `<p class="hint">search unavailable: ${esc(error.message)}</p>`;
      }
    });
    clear.addEventListener("click", () => { input.value = ""; searchHit = null; links = []; clear.hidden = true; render(null); draw(); });

    new ResizeObserver(resize).observe(canvas);
    matchMedia("(prefers-color-scheme:dark)").addEventListener("change", draw);
    new MutationObserver(draw).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    shown();
    render(null);
    resize();
  }

  /* ---------------- flow ---------------- */
  async function mountFlow(root, repository, seed) {
    const list = slot(root, "steps");
    const select = slot(root, "seedSelect");
    list.innerHTML = `<li><span class="n"></span><span class="rel"></span><span class="node">walking the symbol graph…</span></li>`;
    let payload;
    try {
      payload = await api(`/api/ui/flow/${encodeURIComponent(repository)}${seed ? `?seed=${encodeURIComponent(seed)}` : ""}`);
    } catch (error) {
      list.innerHTML = `<li><span class="n"></span><span class="rel"></span><span class="node">graph unavailable: ${esc(error.message)}</span></li>`;
      return;
    }

    if (!select.dataset.filled && payload.entryPoints) {
      select.innerHTML = payload.entryPoints
        .map((entry) => `<option value="${esc(entry)}"${entry === payload.seed ? " selected" : ""}>${esc(entry.split("/").pop())}</option>`)
        .join("");
      select.dataset.filled = "1";
      select.addEventListener("change", () => mountFlow(root, repository, select.value));
    }

    slot(root, "graphNote").innerHTML = payload.totalEdges
      ? `<b>${payload.totalEdges}</b> typed edges · ` +
        Object.entries(payload.edgeTypes || {}).map(([k, v]) => `${k} ${v}`).join(" · ")
      : "";
    slot(root, "flowNote").innerHTML =
      `<b>${payload.steps.length}</b> steps kept · <b>${payload.prunedSteps}</b> pruned as helper detail`;

    const shortName = (key) => (key.includes("#") ? key.split("/").pop() : key);
    list.innerHTML = payload.steps.length
      ? payload.steps.map((step) =>
          `<li class="d${Math.min(step.depth, 5)}${step.boundary ? " boundary" : ""}">` +
          `<span class="n">${step.order}</span><span class="rel">${esc(step.edge)}</span>` +
          `<span class="node">${esc(shortName(step.to))}` +
          `${step.boundary ? '<span class="tag">browser → server</span>' : ""}` +
          `<span class="cite">${esc(step.file)}:${step.line} · ${esc(step.confidence)}</span></span></li>`).join("")
      : `<li><span class="n"></span><span class="rel"></span><span class="node">no traversable entry point in this index</span></li>`;

    slot(root, "traceFoot").innerHTML =
      `<div>upstream reached <b>${payload.endpoints.length ? esc(payload.endpoints.join(", ")) : "none"}</b></div>` +
      `<div>configuration on the path <b>${payload.config.length ? esc(payload.config.join(", ")) : "none"}</b></div>`;
  }

  /* ---------------- project view ---------------- */
  async function select(name) {
    state.current = name;
    renderRail();
    const main = $("#main");
    main.innerHTML = `<div class="empty mono">projecting ${esc(name)} …</div>`;

    const project = state.projects.find((item) => item.name === name);
    let projection;
    try {
      projection = await api(`/api/ui/projection/${encodeURIComponent(name)}`);
    } catch (error) {
      main.innerHTML = `<div class="empty mono">could not project this index: ${esc(error.message)}</div>`;
      return;
    }

    const view = document.importNode($("#tpl-project").content, true);
    slot(view, "eyebrow").textContent = `${project.framework || "repository"} · ${project.router || "?"} router`;
    slot(view, "title").innerHTML = `${project.facts} facts,<br>every one cited.`;
    slot(view, "guidance").textContent = project.freshness
      ? project.freshness.guidance
      : "Freshness could not be read for this repository.";
    slot(view, "stamp").innerHTML =
      `repository <b>${esc(project.name)}</b><br>` +
      `snapshot &nbsp;<b>${esc(String(project.lastIndexedSha || "—").slice(0, 10))}</b><br>` +
      `indexed &nbsp;&nbsp;<b>${esc(project.lastIndexedAt || "—")}</b><br>` +
      `embedding <b>${projection.dimension}-dim</b> · local`;

    renderMetrics(view, project, projection);
    main.innerHTML = "";
    main.appendChild(view);

    const mounted = main;
    if (projection.points.length >= 3) mountPlot(mounted, projection, name);
    else slot(mounted, "inspect").innerHTML = `<p class="hint">This index has no embeddings, so there is nothing to project.<br>Re-index with MEMORY_EMBEDDINGS_ENABLED=1.</p>`;
    mountFlow(mounted, name);
  }

  /* ---------------- boot ---------------- */
  (async () => {
    try {
      const payload = await api("/api/ui/projects");
      state.projects = payload.repositories;
      $("#railFoot").innerHTML =
        `vector search ${payload.vectorEnabled ? "on" : "off"}<br>${state.projects.length} repositor${state.projects.length === 1 ? "y" : "ies"} indexed`;
      if (!state.projects.length) {
        $("#main").innerHTML = `<div class="empty mono">no repository indexed yet — run <b>pnpm memory full &lt;repository&gt;</b></div>`;
        renderRail();
        return;
      }
      await select(state.projects[0].name);
    } catch (error) {
      $("#main").innerHTML = `<div class="empty mono">index unavailable: ${esc(error.message)}</div>`;
    }
  })();
})();
