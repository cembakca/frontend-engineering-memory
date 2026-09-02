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

  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { accept: "application/json", ...(options.headers || {}) } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
    return payload;
  }

  const state = { projects: [], current: null, view: null, selection: null };

  /* ---------------- rail ---------------- */
  function renderRail() {
    const nav = $("#projects");
    nav.innerHTML = "";
    const projects = matchMedia("(max-width:900px)").matches
      ? [...state.projects].sort((a, b) => Number(b.name === state.current) - Number(a.name === state.current))
      : state.projects;
    for (const project of projects) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "project";
      button.setAttribute("aria-current", String(project.name === state.current));
      const freshness = project.freshness ? project.freshness.state : "idle";
      button.innerHTML =
        `<span class="pname">${esc(project.name)}</span>` +
        `<span class="pmeta"><span><i class="dot ${esc(freshness)}"></i>${esc(freshness === "idle" ? "not loaded" : freshness)}</span>` +
        (project.facts == null
          ? `<span>${esc(project.framework || "repository")}</span></span>`
          : `<span>${project.facts} facts</span><span>${project.routes} routes</span></span>`);
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
    slot(root, "pcaNote").innerHTML = !projection ? "projection loading…" : projection.explained.length
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

  /* ---------------- ask memory ---------------- */
  const PROMPTS = [
    ["route lookup", "Kart sihirbazı ana sayfası hangi route ve source dosyasındadır?"],
    ["data flow", "Faizsiz fırsatlar sayfası ürün verisini hangi akışla alır?"],
    ["impact", "Refresh-token client değişirse hangi handler ve kullanıcı akışı etkilenir?"],
    ["verify", "Bu repository'de hangi test, typecheck ve build doğrulamaları çalıştırılabilir?"],
  ];

  function packEvidence(pack) {
    const rows = [];
    const add = (label, source, meta) => rows.push({ label: String(label || "unnamed evidence"), source: source || "", meta: meta || "" });
    for (const item of pack.items || []) add(item.subject || item.entity, item.sourceFile || (item.sourceFiles || []).join(", "), item.type || item.content);
    for (const item of pack.steps || []) add(`${item.relation || item.edge || "step"} → ${item.to}`, item.evidence?.file, [item.evidence?.line, item.evidence?.symbol].filter(Boolean).join(" · "));
    for (const item of pack.facts || []) add(item.fact || item.entity, (item.evidence || []).map((e) => e.file).join(", "), item.type);
    for (const item of pack.exemplars || []) add(item.fact || item.entity, (item.evidence || []).map((e) => e.file).join(", "), item.type);
    for (const item of pack.relations || []) add(item.affected || item.packageName || item.dependency, item.evidence?.file, item.relation || item.direction);
    for (const item of pack.changes || []) add(`${item.operation}: ${item.entity}`, item.file, `${item.fromSha || "?"} → ${item.toSha || "?"}`);
    for (const item of pack.verification?.commands || []) add(item.command, item.evidence?.file, item.kind);
    for (const item of pack.verification?.tests || []) add(item.key, item.evidence?.file, item.framework);
    if (pack.routeContext) add(pack.routeContext.route, pack.routeContext.sourceFile, "route context");
    if (pack.route) add(pack.route.route, pack.route.sourceFile, [pack.route.type, pack.route.rendering, pack.route.router && `${pack.route.router} router`].filter(Boolean).join(" · "));
    for (const item of pack.route?.renderingEvidence || []) add(item.split(":")[0], item, "rendering evidence");
    for (const item of pack.route?.controlFlow || []) add(`${item.kind}${item.target ? ` → ${item.target}` : ""}`, pack.route.sourceFile, item.conditional ? "conditional" : "unconditional");
    for (const item of pack.relatedRoutes || []) add(item.route, item.sourceFile, "related route");
    return rows.slice(0, 30);
  }

  function renderPack(root, repository, response) {
    const pack = response.pack;
    const contract = pack.answerContract || { uncertainty: { level: "insufficient", reasons: [] }, sourceFallback: [] };
    const level = contract.uncertainty?.level || "insufficient";
    const fallback = contract.sourceFallback || [];
    const rounds = pack.retrieval;
    // Three distinct states, not two: memory answered on its own; memory
    // answered but the plan opened its recovery round and offers files to read;
    // memory could not answer. Collapsing the middle one into "partial" made a
    // deliberate targeted-source policy look like an uncertain answer.
    const status = level === "none" && fallback.length === 0 ? { tone: "good", label: "memory sufficient" }
      : level !== "insufficient" && fallback.length ? { tone: "info", label: "targeted source" }
      : { tone: level === "partial" ? "warn" : "bad", label: level };
    const evidence = packEvidence(pack);
    const budget = pack.budget || {};
    const output = slot(root, "askOutput");
    output.hidden = false;
    output.innerHTML =
      `<div class="pack-head"><div class="pack-kind">${esc(String(pack.kind || "context").replace(/-/g, " "))}` +
        `<small>${esc(pack.snapshotSha ? pack.snapshotSha.slice(0, 10) : "no snapshot")} · telemetry #${esc(pack.telemetryEventId || "—")}` +
        `${pack.retrieval ? ` · ${esc((pack.retrieval.rounds || []).join(" → "))}${pack.retrieval.resolvedBy ? ` · ${esc(pack.retrieval.resolvedBy)}` : ""}` : ""}</small></div>` +
        `<span class="contract-badge ${status.tone}">${esc(status.label)}</span></div>` +
      `<div class="pack-stats">` +
        `<div class="pack-stat"><b>${budget.usedChars ?? JSON.stringify(pack).length}</b><span>payload chars</span></div>` +
        `<div class="pack-stat"><b>${budget.estimatedTokens ?? Math.ceil((budget.usedChars ?? JSON.stringify(pack).length) / 3.5)}</b><span>estimated tokens</span></div>` +
        `<div class="pack-stat"><b>${response.durationMs}</b><span>compile ms</span></div>` +
        `<div class="pack-stat"><b>${fallback.length}</b><span>source fallbacks</span></div></div>` +
      `<div class="pack-columns"><section class="pack-section"><div class="pack-section-head"><h3>Returned evidence</h3><span>${evidence.length} visible claims</span></div>` +
        `<ul class="evidence-list">${evidence.length ? evidence.map((item) => `<li><span class="claim">${esc(item.label)}</span>` +
          `<span class="source">${esc(item.source || "derived relation")}${item.meta ? ` · ${esc(item.meta)}` : ""}</span></li>`).join("") : `<li><span class="source">No evidence returned.</span></li>`}</ul></section>` +
      `<section class="pack-section"><div class="pack-section-head"><h3>Answer contract</h3><span>${esc(level)}</span></div>` +
        `<ul class="contract-list"><li><b>facts</b> ${(contract.facts || []).length}</li><li><b>derived relations</b> ${(contract.derivedRelations || []).length}</li>` +
        `<li><b>inferences</b> ${(contract.inferences || []).length}</li>` +
        `${(contract.uncertainty?.reasons || []).map((reason) => `<li>uncertainty · ${esc(reason)}</li>`).join("")}` +
        `${rounds ? `<li><b>rounds</b> ${esc((rounds.rounds || []).join(" → "))}${rounds.secondRound?.run
          ? `<br>second round · ${esc((rounds.secondRound.triggers || []).join(", "))}` : ""}</li>` : ""}` +
        `${fallback.map((item) => `<li><b>fallback ${item.priority}</b><br>${esc(item.file)} · ${esc(item.reason)}</li>`).join("")}</ul>` +
        `<div class="feedback-row" data-event="${esc(pack.telemetryEventId || "")}"><button type="button" data-signal="sufficient">Sufficient</button>` +
        `<button type="button" data-signal="source-needed">Source needed</button><button type="button" data-signal="wrong">Wrong</button></div></section></div>` +
      `<details class="raw-pack"><summary>Inspect raw bounded pack</summary><pre>${esc(JSON.stringify(pack, null, 2))}</pre></details>`;
    output.querySelectorAll("[data-signal]").forEach((button) => button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await api("/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          repository, retrievalEventId: pack.telemetryEventId, signal: button.dataset.signal, reporter: "browser-ui",
        }) });
        button.textContent = "Recorded";
      } catch (error) { button.textContent = error.message; button.disabled = false; }
    }));
  }

  function mountAsk(root, repository) {
    const form = slot(root, "askForm");
    const input = slot(root, "askInput");
    const status = slot(root, "askStatus");
    const submit = form.querySelector("button[type=submit]");
    slot(root, "askPresets").innerHTML = PROMPTS.map(([label, prompt]) =>
      `<button type="button" class="preset" data-prompt="${esc(prompt)}">${esc(label)}</button>`).join("");
    slot(root, "askPresets").querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => {
      input.value = button.dataset.prompt; input.focus();
    }));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const question = input.value.trim();
      if (question.length < 3) return input.focus();
      submit.disabled = true;
      status.textContent = "compiling bounded context · checking indexed evidence…";
      try {
        const response = await api(`/api/ui/ask/${encodeURIComponent(repository)}`, { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) });
        renderPack(root, repository, response);
        const pack = response.pack;
        status.textContent = `${pack.kind || "context"} · ${response.durationMs} ms · ${pack.budget?.usedChars || JSON.stringify(pack).length} chars · ${(pack.answerContract?.sourceFallback || []).length} source fallback`;
      } catch (error) { status.textContent = `query failed · ${error.message}`; }
      finally { submit.disabled = false; }
    });
  }

  /* ---------------- route explorer ---------------- */
  const tokens = (values) => values && values.length
    ? `<div class="token-list">${values.map((value) => `<code>${esc(typeof value === "string" ? value : JSON.stringify(value))}</code>`).join("")}</div>`
    : `<p class="hint">None recorded.</p>`;

  function renderRouteDetail(root, detail) {
    const scope = detail.dependencyScope || { direct: [], inherited: [] };
    const dependencies = [...(scope.direct || []).slice(0, 12).map((item) => ({ ...item, scope: "direct" })),
      ...(scope.inherited || []).filter((item, index, all) => all.findIndex((other) => other.name === item.name && other.usage_type === item.usage_type) === index)
        .slice(0, 8).map((item) => ({ ...item, scope: "inherited" }))];
    const routeDirectory = detail.sourceFile.slice(0, detail.sourceFile.lastIndexOf("/"));
    const localBoundaries = (detail.clientBoundaries || []).filter((file) => file.startsWith(`${routeDirectory}/`));
    const clientBoundaries = (localBoundaries.length ? localBoundaries : detail.clientBoundaries || []).slice(0, 12);
    slot(root, "routeDetail").innerHTML =
      `<div class="eyebrow">${esc(detail.type)} · ${esc(detail.router)} router</div><h3>${esc(detail.route)}</h3>` +
      `<div class="source-line">${esc(detail.sourceFile)}</div>` +
      `<div class="detail-facts"><div class="detail-fact"><b>${esc(detail.rendering)}</b><span>rendering</span></div>` +
      `<div class="detail-fact"><b>${detail.serverComponent == null ? "unknown" : detail.serverComponent ? "server" : "client"}</b><span>component boundary</span></div>` +
      `<div class="detail-fact"><b>${detail.authRequired == null ? "unknown" : detail.authRequired ? "required" : "public"}</b><span>authentication</span></div></div>` +
      `<section class="detail-section"><h4>Control flow</h4>${tokens(detail.controlFlow)}</section>` +
      `<section class="detail-section"><h4>Layout chain</h4>${tokens(detail.layoutChain)}</section>` +
      `<section class="detail-section"><h4>Local client boundaries · ${clientBoundaries.length}</h4>${tokens(clientBoundaries)}</section>` +
      `<section class="detail-section"><h4>Data sources</h4>${tokens(detail.dataSources)}</section>` +
      `<section class="detail-section"><h4>Backend dependencies</h4>${tokens(detail.backendDependencies)}</section>` +
      `<section class="detail-section"><h4>Cache behavior</h4>${tokens(detail.cacheBehavior)}</section>` +
      `<section class="detail-section"><h4>Dependency scope · ${scope.direct?.length || 0} direct / ${scope.inherited?.length || 0} inherited</h4>` +
        (dependencies.length ? `<table class="dependency-table"><tbody>${dependencies.map((item) => `<tr><td>${esc(item.scope)} · ${esc(item.usage_type || item.dependency_type || "dependency")}</td><td>${esc(item.name || item.source_file || "—")}</td></tr>`).join("")}</tbody></table>` : `<p class="hint">No route dependency rows recorded.</p>`) + `</section>`;
  }

  function mountRoutes(root, repository) {
    const form = slot(root, "routeSearchForm");
    const input = slot(root, "routeSearchInput");
    const list = slot(root, "routeList");
    let timer;
    const load = async () => {
      list.innerHTML = `<div class="empty-state">loading structured routes…</div>`;
      try {
        const payload = await api(`/api/ui/routes/${encodeURIComponent(repository)}?q=${encodeURIComponent(input.value.trim())}`);
        slot(root, "routeCount").textContent = `${payload.matched} matched · ${payload.total} indexed`;
        list.innerHTML = payload.routes.length ? payload.routes.map((route) =>
          `<button type="button" class="route-row" aria-selected="false" data-route="${esc(route.route)}"><span class="route-path">${esc(route.route)}</span>` +
          `<span class="route-source">${esc(route.sourceFile)}</span><span class="route-flags"><span class="route-flag">${esc(route.rendering)}</span>` +
          `${route.authRequired ? '<span class="route-flag">auth</span>' : ""}${route.dataSources ? `<span class="route-flag">${route.dataSources} data</span>` : ""}</span></button>`).join("")
          : `<div class="empty-state">No route matches this filter.</div>`;
        list.querySelectorAll("[data-route]").forEach((button) => button.addEventListener("click", async () => {
          list.querySelectorAll("[data-route]").forEach((row) => row.setAttribute("aria-selected", "false"));
          button.setAttribute("aria-selected", "true");
          slot(root, "routeDetail").innerHTML = `<p class="hint">loading ${esc(button.dataset.route)}…</p>`;
          try { renderRouteDetail(root, await api(`/api/ui/route/${encodeURIComponent(repository)}?route=${encodeURIComponent(button.dataset.route)}`)); }
          catch (error) { slot(root, "routeDetail").innerHTML = `<p class="hint">${esc(error.message)}</p>`; }
        }));
      } catch (error) { list.innerHTML = `<div class="empty-state">${esc(error.message)}</div>`; }
    };
    form.addEventListener("submit", (event) => { event.preventDefault(); load(); });
    input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(load, 180); });
    load();
  }

  /* ---------------- economy ---------------- */
  const percent = (value) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)}%` : "—";
  function observationSavings(observation) {
    const value = observation.savingsPercent || {};
    return {
      input: value.inputTokens ?? value.inputPercent,
      uncached: value.uncachedInputTokens ?? value.uncachedInputPercent,
      payload: value.toolChars ?? value.toolPayloadPercent,
      time: value.wallTime ?? value.latencyPercent,
    };
  }
  function savingBar(label, value) {
    const width = Math.max(0, Math.min(100, Number(value) || 0));
    return `<div class="saving"><span>${esc(label)}</span><b>${percent(value)}</b><i><span style="width:${width}%"></span></i></div>`;
  }
  async function mountEconomy(root, repository) {
    slot(root, "economySummary").innerHTML = `<div class="empty-state">loading retrieval ledger…</div>`;
    try {
      const payload = await api(`/api/ui/economy/${encodeURIComponent(repository)}`);
      const report = payload.report;
      const fallbacks = report.byFallback || {};
      const sufficient = report.events ? ((fallbacks.none || 0) / report.events) * 100 : 0;
      slot(root, "economySummary").innerHTML =
        `<div class="economy-card"><div class="value">${report.events}</div><div class="label">retrieval events</div><div class="note">latest retained sample</div></div>` +
        `<div class="economy-card good"><div class="value">${percent(sufficient)}</div><div class="label">no fallback</div><div class="note">memory answered alone</div></div>` +
        `<div class="economy-card"><div class="value">${report.estimatedTokens?.p50 ?? "—"}</div><div class="label">median pack tokens</div><div class="note">engine estimate, not billing</div></div>` +
        `<div class="economy-card"><div class="value">${report.latencyMs?.p50 ?? "—"} ms</div><div class="label">median retrieval</div><div class="note">p95 ${report.latencyMs?.p95 ?? "—"} ms</div></div>`;
      slot(root, "eventCount").textContent = `${payload.recent.length} shown`;
      slot(root, "events").innerHTML = payload.recent.length ? payload.recent.map((event) =>
        `<div class="event"><time>${esc(String(event.created_at || "").slice(5, 16))}</time><span class="event-kind"><b>${esc(event.pack_kind || event.tool)}</b>` +
        `<span>${esc(event.intent || "unknown")} · ${esc(event.fallback || "none")}</span></span><span class="event-cost"><b>${event.estimated_tokens}</b><span>tok · ${event.latency_ms}ms</span></span></div>`).join("")
        : `<div class="empty-state">No retrieval telemetry yet. Ask Memory will create the first event.</div>`;
      slot(root, "observations").innerHTML = payload.observations.length ? payload.observations.map((observation) => {
        const saving = observationSavings(observation);
        return `<article class="observation"><div class="observation-title"><b>${esc(observation.caseId)}</b><span>${esc(observation.model || "model unknown")} · ${esc(observation.date || "")}</span></div>` +
          `<p class="observation-prompt">${esc(observation.prompt || "Controlled retrieval observation")}</p><div class="saving-bars">` +
          savingBar("input", saving.input) + savingBar("uncached", saving.uncached) + savingBar("tool payload", saving.payload) + savingBar("wall time", saving.time) + `</div></article>`;
      }).join("") : `<div class="empty-state">No checked-in Codex A/B observation is linked to this repository.</div>`;
    } catch (error) { slot(root, "economySummary").innerHTML = `<div class="empty-state">${esc(error.message)}</div>`; }
  }

  async function mountLab(root, repository) {
    mountFlow(root, repository);
    try {
      const projection = await api(`/api/ui/projection/${encodeURIComponent(repository)}`);
      if (state.current !== repository) return;
      slot(root, "stamp").innerHTML = slot(root, "stamp").innerHTML.replace(
        "embedding <b>deferred</b>", `embedding <b>${projection.dimension}-dim</b>`);
      const project = state.projects.find((item) => item.name === repository);
      renderMetrics(root, project, projection);
      if (projection.points.length >= 3) mountPlot(root, projection, repository);
      else slot(root, "inspect").innerHTML = `<p class="hint">This index has no embeddings, so there is nothing to project.<br>Re-index with MEMORY_EMBEDDINGS_ENABLED=1.</p>`;
    } catch (error) { slot(root, "pcaNote").textContent = `projection unavailable: ${error.message}`; }
  }

  function mountWorkspace(root, repository) {
    const valid = new Set(["ask", "routes", "economy", "lab"]);
    const requested = new URL(location.href).searchParams.get("view");
    const initial = valid.has(requested) ? requested : "ask";
    const activate = (name) => {
      root.querySelectorAll("[data-view]").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.view === name)));
      root.querySelectorAll("[data-panel]").forEach((panel) => { panel.hidden = panel.dataset.panel !== name; });
      const url = new URL(location.href); url.searchParams.set("view", name); history.replaceState(null, "", url);
      const panel = root.querySelector(`[data-panel="${name}"]`);
      if (panel.dataset.mounted) return;
      panel.dataset.mounted = "1";
      if (name === "ask") mountAsk(root, repository);
      else if (name === "routes") mountRoutes(root, repository);
      else if (name === "economy") mountEconomy(root, repository);
      else mountLab(root, repository);
    };
    root.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => activate(button.dataset.view)));
    activate(initial);
  }

  /* ---------------- project view ---------------- */
  async function select(name) {
    const selection = Symbol(name);
    state.selection = selection;
    state.current = name;
    localStorage.setItem("context-engine.repository", name);
    const locationUrl = new URL(location.href);
    locationUrl.searchParams.set("repo", name);
    history.replaceState(null, "", locationUrl);
    renderRail();
    const main = $("#main");
    main.innerHTML = `<div class="empty mono">loading ${esc(name)} …</div>`;

    let project;
    try {
      project = await api(`/api/ui/project/${encodeURIComponent(name)}`);
    } catch (error) {
      main.innerHTML = `<div class="empty mono">could not load this index: ${esc(error.message)}</div>`;
      return;
    }
    if (state.selection !== selection) return;
    const index = state.projects.findIndex((item) => item.name === name);
    if (index >= 0) state.projects[index] = project;
    renderRail();

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
      `embedding <b>deferred</b> · local`;

    renderMetrics(view, project, null);
    main.innerHTML = "";
    main.appendChild(view);

    const mounted = main;
    mountWorkspace(mounted, name);
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
      const requested = new URL(location.href).searchParams.get("repo") || localStorage.getItem("context-engine.repository");
      const initial = state.projects.some((project) => project.name === requested) ? requested : state.projects[0].name;
      await select(initial);
    } catch (error) {
      $("#main").innerHTML = `<div class="empty mono">index unavailable: ${esc(error.message)}</div>`;
    }
  })();
})();
