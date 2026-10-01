/* InsertPress Planner — app wiring. */
(function () {
  'use strict';
  const IP = window.IP;
  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const fmt = IP.gcode.fmt;
  const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const X_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 2l8 8M10 2l-8 8"/></svg>';

  const SCHEMA = [
    { group: 'Job', items: [
      { key: 'mode', label: 'Motion', type: 'select', options: [['xy', 'Move X and Y'], ['manual', 'Z only']],
        help: 'Z only is for the press head before the gantry exists. The job pauses at each hole so you slide the part under the tip.' },
      { key: 'loadMode', label: 'Load inserts', type: 'select', options: [['each', 'Before each hole'], ['start', 'All at the start']] },
      { key: 'overloadStop', label: 'Stop if the float sensor trips', type: 'bool',
        help: 'Presses with G38.3, so the plunge halts if the float sensor on the probe pin trips (crooked insert, missing hole).' },
      { key: 'defaultInsert', label: 'Insert for hand-placed holes', type: 'insert' },
    ] },
    { group: 'Press', items: [
      { key: 'sink', label: 'Finish below the surface', unit: 'mm', step: 0.05 },
      { key: 'approachGap', label: 'Slow down above the insert', unit: 'mm', step: 0.5 },
      { key: 'pressFeed', label: 'Press speed', unit: 'mm/min', step: 5 },
      { key: 'dwell', label: 'Hold at depth', unit: 's', step: 0.5 },
      { key: 'retractSlow', label: 'Slow lift distance', unit: 'mm', step: 0.5 },
      { key: 'retractFeed', label: 'Slow lift speed', unit: 'mm/min', step: 10 },
    ] },
    { group: 'Travel', items: [
      { key: 'clearance', label: 'Clearance over the tallest insert', unit: 'mm', step: 1 },
      { key: 'minClear', label: 'Never travel below', unit: 'mm', step: 1 },
      { key: 'bedX', label: 'X travel from the fence', unit: 'mm', step: 10 },
      { key: 'bedY', label: 'Y travel from the fence', unit: 'mm', step: 10 },
      { key: 'park', label: 'Park when finished', type: 'bool' },
      { key: 'parkX', label: 'Park X', unit: 'mm', step: 10 },
      { key: 'parkY', label: 'Park Y', unit: 'mm', step: 10 },
      { key: 'rapidXY', label: 'Rapid speed X/Y', unit: 'mm/min', step: 100,
        help: 'Rapid speeds only feed the time estimate. Match them to your $110 and $112.' },
      { key: 'rapidZ', label: 'Rapid speed Z', unit: 'mm/min', step: 50 },
    ] },
    { group: 'Hole finding', items: [
      { key: 'dMin', label: 'Smallest hole', unit: 'mm', step: 0.1 },
      { key: 'dMax', label: 'Largest hole', unit: 'mm', step: 0.1 },
    ] },
  ];
  const STEPS = ['part', 'holes', 'machine', 'export'];
  const STEP_NAMES = { part: 'Part', holes: 'Holes', machine: 'Machine', export: 'Export' };

  const LS_KEY = 'insertpress.settings.v1';
  function loadSettings() {
    try { return Object.assign({}, IP.DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(LS_KEY) || 'null') || {}); }
    catch (e) { return Object.assign({}, IP.DEFAULT_SETTINGS); }
  }
  function saveSettings() { try { localStorage.setItem(LS_KEY, JSON.stringify(S.settings)); } catch (e) { /* storage off */ } }

  const S = {
    raw: null, name: '', rot: { x: 0, y: 0, z: 0 }, scale: 1,
    part: null, holes: [], ignored: [], order: [],
    settings: loadSettings(), step: 'part',
    activeId: null, hoverId: null, addMode: false,
    nextId: 1, result: null, pendingJob: null, hintedAdd: false,
  };

  /* ---------- toast ---------- */
  let toastTimer;
  function toast(msg, isError) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('error', !!isError);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 5200 : 2800);
  }

  /* ---------- viewer ---------- */
  const has3D = !!(window.THREE && THREE.OrbitControls);
  const handlers = { onPick, addMode: () => S.addMode, onHover };
  let viewer = null;
  try {
    viewer = has3D ? new IP.Viewer($('viewport'), handlers) : new IP.Viewer2D($('viewport'), handlers);
  } catch (e) {
    viewer = new IP.Viewer2D($('viewport'), handlers);
  }
  const is2D = viewer instanceof IP.Viewer2D;
  if (is2D) $('view-seg').hidden = true;
  viewer.setBed(S.settings.bedX, S.settings.bedY);

  /* ---------- steps ---------- */
  function goStep(name) {
    S.step = name;
    $$('.step').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.step === name)));
    STEPS.forEach((s) => { $('pane-' + s).hidden = s !== name; });
    const i = STEPS.indexOf(name);
    $('btn-back').hidden = i === 0;
    const nb = $('btn-next');
    nb.hidden = i === STEPS.length - 1;
    if (i < STEPS.length - 1) nb.textContent = `Next: ${STEP_NAMES[STEPS[i + 1]]}`;
    nb.disabled = !S.part;
    nb.classList.toggle('primary', !!S.part && name === 'machine' && S.order.length > 0);
    if (name !== 'holes' && S.addMode) setAddMode(false);
    document.querySelector('.panes').scrollTop = 0;
  }

  /* ---------- loading ---------- */
  function readFile(file) {
    if (!file) return;
    const name = file.name || 'part.stl';
    const r = new FileReader();
    r.onerror = () => toast(`Could not read ${name}.`, true);
    if (/\.(json|ipjob)$/i.test(name)) {
      r.onload = () => openJob(r.result);
      r.readAsText(file);
    } else {
      r.onload = () => loadSTL(r.result, name);
      r.readAsArrayBuffer(file);
    }
  }

  function loadSTL(buf, name) {
    let raw;
    try { raw = IP.stl.parseSTL(buf); } catch (e) { toast(e.message, true); return; }
    if (!raw.length) { toast(`${name} has no triangles.`, true); return; }
    S.raw = raw;
    S.name = name.replace(/\.stl$/i, '');
    S.rot = { x: 0, y: 0, z: 0 };
    const pj = S.pendingJob;
    S.pendingJob = null;
    if (pj) { applyJob(pj); return; }
    rebuild();
    goStep('holes');
  }

  function loadExample() {
    S.raw = IP.exampleBlock();
    S.name = 'example-block';
    S.rot = { x: 0, y: 0, z: 0 };
    setUnits(1, false);
    rebuild();
    goStep('holes');
  }

  function rebuild() {
    S.part = IP.stl.preparePart(S.raw, { rot: S.rot, scale: S.scale });
    S.holes = []; S.order = []; S.activeId = null;
    viewer.setPart(S.part.positions, S.part.size);
    onPartReady();
    detect(false);
  }

  function onPartReady() {
    $('stage-empty').hidden = true;
    $('legend').hidden = false;
    $('view-tools').hidden = false;
    $('part-intro').hidden = true;
    $('part-loaded').hidden = false;
    $$('#btn-all, #btn-none, #btn-optimize, #btn-add, #btn-save-job, #btn-save-job-2').forEach((b) => { b.disabled = false; });
    $('btn-next').disabled = false;
  }

  const xyKey = (h) => Math.round(h.x * 20) + ':' + Math.round(h.y * 20);

  function detect(keep) {
    if (!S.part) return;
    const res = IP.holes.detect(S.part.positions, { dMin: S.settings.dMin, dMax: S.settings.dMax });
    const old = keep ? new Map(S.holes.filter((h) => h.source === 'auto').map((h) => [xyKey(h), h])) : new Map();
    const manual = keep ? S.holes.filter((h) => h.source === 'manual') : [];
    const auto = res.holes.map((r) => {
      const prev = old.get(xyKey(r));
      return {
        id: prev ? prev.id : S.nextId++, source: 'auto',
        x: r.x, y: r.y, H: r.top, dia: r.dia, depth: r.depth, blind: r.blind,
        insert: prev ? prev.insert : IP.gcode.guessInsert(r.dia, 'm3'),
        sink: prev ? prev.sink : null,
      };
    });
    S.holes = auto.concat(manual);
    const ids = new Set(S.holes.map((h) => h.id));
    S.order = S.order.filter((id) => ids.has(id));
    S.ignored = res.ignored;
    if (!keep && !auto.length) toast('No insert-sized holes face up. Turn the part, widen the size range, or place holes by hand.');
    refresh();
  }

  /* ---------- picking & hover ---------- */
  function onPick(p) {
    if (!S.part) return;
    if (p.type === 'hole') {
      toggleOrder(p.id);
      if (S.step !== 'holes') goStep('holes');
      return;
    }
    if (!S.addMode) {
      if (!S.hintedAdd) { S.hintedAdd = true; toast('To add a hole where none was found, use Place by hand.'); }
      return;
    }
    if (p.normalZ < 0.9) { toast('That surface is not flat and facing up. Pick a top face.', true); return; }
    const x = p.point.x, y = p.point.y;
    if (S.holes.some((h) => Math.hypot(h.x - x, h.y - y) < 1.5)) { toast('There is already a hole there.'); return; }
    const h = { id: S.nextId++, source: 'manual', x, y, H: p.point.z, dia: null, depth: null, blind: false,
      insert: S.settings.defaultInsert, sink: null };
    S.holes.push(h);
    S.order.push(h.id);
    S.activeId = h.id;
    refresh();
  }

  function onHover(id, cx, cy) {
    const card = $('tip-card');
    if (id == null) {
      card.hidden = true;
    } else {
      const h = byId(id);
      if (h) {
        const idx = S.order.indexOf(id);
        const ins = IP.INSERTS[h.insert];
        card.innerHTML = `<b>${idx >= 0 ? 'Hole ' + (idx + 1) : 'Not pressed'}</b>
          <div class="xy"><i>X</i><span>${f2(h.x)}</span><i>Y</i><span>${f2(h.y)}</span></div>
          <div>${h.source === 'manual' ? 'Placed by hand' : '⌀' + f2(h.dia) + ' mm'}, ${esc(ins.name)} insert</div>
          <div class="act">${idx >= 0 ? 'Click to take out' : 'Click to press'}</div>`;
        card.hidden = false;
        const pad = 16, w = card.offsetWidth, hh = card.offsetHeight;
        let left = cx + pad, top = cy + pad;
        if (left + w > window.innerWidth - 8) left = cx - w - pad;
        if (top + hh > window.innerHeight - 8) top = cy - hh - pad;
        card.style.left = left + 'px';
        card.style.top = top + 'px';
      }
    }
    if (id !== S.hoverId) { S.hoverId = id; updateView(); markHoverRow(); }
  }

  function toggleOrder(id) {
    const i = S.order.indexOf(id);
    if (i >= 0) { S.order.splice(i, 1); if (S.activeId === id) S.activeId = null; }
    else { S.order.push(id); S.activeId = id; }
    refresh();
  }

  function setAddMode(on) {
    S.addMode = on;
    $('btn-add').setAttribute('aria-pressed', String(on));
    $('add-hint').hidden = !on;
  }

  function setUnits(scale, rebuildNow) {
    S.scale = scale;
    $$('[data-units]').forEach((b) => b.setAttribute('aria-checked', String(+b.dataset.units === scale)));
    if (rebuildNow && S.raw) rebuild();
  }

  /* ---------- rendering ---------- */
  const byId = (id) => S.holes.find((h) => h.id === id);
  const insertOptions = (sel) => Object.entries(IP.INSERTS)
    .map(([k, v]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${esc(v.name)}</option>`).join('');

  function refresh() {
    renderPart();
    regen();
    renderHoles();
    updateView();
    $('btn-next').classList.toggle('primary', S.step === 'machine' && S.order.length > 0);
  }

  function renderPart() {
    if (!S.part) return;
    const s = S.part.size;
    $('part-name').textContent = S.name;
    $('part-tris').textContent = `${S.part.triCount.toLocaleString()} triangles`;
    $('part-dims').innerHTML = ['x', 'y', 'z'].map((k) =>
      `<div><b>${f2(s[k])}</b><span>${k.toUpperCase()} mm</span></div>`).join('');
    $('file-chip').hidden = false;
    $('file-chip').textContent = `${S.name}.stl`;
  }

  function holeMeta(h) {
    if (h.source === 'manual') return `Placed by hand, surface Z ${f2(h.H)}`;
    const kind = h.blind ? `${fmt(h.depth)} mm deep` : 'through';
    return `⌀${f2(h.dia)}, ${kind}, top Z ${f2(h.H)}`;
  }

  const xyHTML = (h) => `<div class="xy"><i>X</i><span>${f2(h.x)}</span><i>Y</i><span>${f2(h.y)}</span></div>`;

  function renderHoles() {
    const issuesByHole = new Map();
    for (const i of (S.result && S.result.issues) || []) {
      if (!i.hole) continue;
      if (!issuesByHole.has(i.hole)) issuesByHole.set(i.hole, []);
      issuesByHole.get(i.hole).push(i.text);
    }
    $('order-list').innerHTML = S.order.map((id, idx) => {
      const h = byId(id);
      const n = idx + 1;
      const flags = (issuesByHole.get(n) || []).map((t) => `<div class="flag">${esc(t)}</div>`).join('');
      const sink = id === S.activeId
        ? `<label class="sink">Finish below surface
             <input type="number" step="0.05" data-sink="${id}" value="${h.sink != null ? h.sink : ''}" placeholder="${fmt(S.settings.sink)}"> mm</label>`
        : '';
      return `<li class="hole${id === S.activeId ? ' active' : ''}" draggable="true" data-id="${id}">
        <span class="tag" title="Drag to reorder">${n}</span>
        ${xyHTML(h)}
        <div class="ins"><select data-insert="${id}" aria-label="Insert for hole ${n}">${insertOptions(h.insert)}</select></div>
        <button class="x-btn" data-remove="${id}" title="Take out of the press order" aria-label="Take hole ${n} out">${X_ICON}</button>
        <div class="meta">${holeMeta(h)}</div>
        ${sink}${flags}</li>`;
    }).join('');
    $('order-empty').hidden = S.order.length > 0 || !S.part;

    const unused = S.holes.filter((h) => !S.order.includes(h.id));
    $('unused-head').hidden = !unused.length;
    $('unused-list').innerHTML = unused.map((h) => `<li class="hole" data-add="${h.id}" title="Add to the press order">
        <span class="tag" aria-hidden="true">+</span>
        ${xyHTML(h)}
        ${h.source === 'manual' ? `<button class="x-btn" data-delete="${h.id}" title="Delete this hand-placed hole" aria-label="Delete hole">${X_ICON}</button>` : ''}
        <div class="meta">${holeMeta(h)}</div>
      </li>`).join('');

    const big = S.ignored.filter((i) => i.reason === 'size').length;
    const blocked = S.ignored.filter((i) => i.reason === 'blocked').length;
    const parts = [];
    if (big) parts.push(`${big} round hole${big === 1 ? '' : 's'} outside ${fmt(S.settings.dMin)}–${fmt(S.settings.dMax)} mm`);
    if (blocked) parts.push(`${blocked} that open${blocked === 1 ? 's' : ''} downward`);
    $('ignored-note').textContent = parts.length ? `Skipped ${parts.join(' and ')}. Adjust the size range on the Machine step.` : '';

    $('count-line').innerHTML = S.part
      ? (S.holes.length
        ? `<b>${S.order.length}</b> of ${S.holes.length} hole${S.holes.length === 1 ? '' : 's'} in the press order`
        : 'No insert holes found. Use Place by hand, or turn the part.')
      : 'Open a part first.';
    const pill = $('pill-holes');
    pill.hidden = !S.order.length;
    pill.textContent = S.order.length;

    $('status').textContent = S.part
      ? (is2D ? 'Top view. Drag to pan, scroll to zoom. (3D view needs an internet connection.)'
        : 'Drag to orbit, right-drag to pan, scroll to zoom.')
      : '';
    markHoverRow();
  }

  function markHoverRow() {
    $$('.hole').forEach((li) => {
      const id = +(li.dataset.id || li.dataset.add);
      li.classList.toggle('hover', id === S.hoverId);
    });
  }

  function updateView() {
    if (!S.part) return;
    viewer.setHoles(S.holes.map((h) => {
      const idx = S.order.indexOf(h.id);
      return { id: h.id, x: h.x, y: h.y, H: h.H, dia: h.dia || IP.INSERTS[h.insert].hole,
        n: idx >= 0 ? idx + 1 : null, active: h.id === S.activeId || h.id === S.hoverId };
    }));
    const s = S.settings;
    if (S.result && S.result.clearZ && s.mode === 'xy' && S.order.length) {
      const cz = S.result.clearZ;
      const pts = [];
      if (s.park) pts.push([s.parkX, s.parkY, cz]);
      for (const id of S.order) {
        const h = byId(id);
        const sink = h.sink != null ? h.sink : s.sink;
        pts.push([h.x, h.y, cz], [h.x, h.y, h.H - sink], [h.x, h.y, cz]);
      }
      if (s.park) pts.push([s.parkX, s.parkY, cz]);
      viewer.setPath(pts);
    } else {
      viewer.setPath(null);
    }
  }

  /* ---------- G-code ---------- */
  function jobHoles() {
    return S.order.map((id) => {
      const h = byId(id);
      return { x: h.x, y: h.y, H: h.H, dia: h.dia, depth: h.depth, blind: h.blind, insert: h.insert, sink: h.sink };
    });
  }

  function regen() {
    if (!S.part) return;
    S.result = IP.gcode.generate({ name: S.name, size: S.part.size, holes: jobHoles(), settings: S.settings });
    const r = S.result;
    const errors = r.issues.filter((i) => i.level === 'error');
    const canExport = !!r.text && !errors.length;
    ['btn-export', 'btn-export-2'].forEach((id) => {
      $(id).disabled = !canExport;
      $(id).title = errors.length ? 'Fix the errors on the Export step first' : '';
    });
    $('btn-copy').disabled = !r.text;
    const pill = $('pill-issues');
    pill.hidden = !r.issues.length;
    pill.textContent = r.issues.length;

    const mins = Math.floor(r.seconds / 60), secs = Math.round(r.seconds % 60);
    $('stats').innerHTML = `
      <div><b>${S.order.length}</b><span>inserts</span></div>
      <div><b>${r.text ? (mins ? mins + 'm ' : '') + secs + 's' : '–'}</b><span>motion, plus load pauses</span></div>
      <div><b>${r.text ? 'Z ' + fmt(r.clearZ) : '–'}</b><span>travel height, mm</span></div>
      <div><b>${S.settings.mode === 'xy' ? 'X, Y, Z' : 'Z only'}</b><span>axes moved</span></div>`;
    $('issues').innerHTML = r.issues.map((i) => `<li class="${i.level}">${esc(i.text)}</li>`).join('');

    if (!r.text) {
      $('code').innerHTML = '<span class="c">; Add at least one hole to the press order.</span>';
      $('code-lines').textContent = '';
      return;
    }
    const lines = r.text.trimEnd().split('\n');
    $('code-lines').textContent = `${lines.length} lines`;
    $('code').innerHTML = lines.map((l) => {
      const [cmd, ...rest] = l.split(';');
      const note = rest.join(';');
      const comment = rest.length ? `<span class="c">;${esc(note)}</span>` : '';
      let cls = '';
      if (/^\(MSG|^M0/.test(cmd)) cls = 'm';
      else if (/press/.test(note)) cls = 'g';
      return (cls ? `<span class="${cls}">${esc(cmd)}</span>` : esc(cmd)) + comment;
    }).join('\n');
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function exportGcode() {
    if (!S.result || !S.result.text) return;
    download(`${S.name}.gcode`, S.result.text, 'text/plain');
    toast(`Downloaded ${S.name}.gcode`);
  }

  /* ---------- jobs ---------- */
  function saveJob() {
    if (!S.part) return;
    const job = {
      format: 'insertpress-job', version: 1,
      part: { name: S.name, triangles: S.part.triCount, rot: S.rot, scale: S.scale },
      settings: S.settings,
      holes: S.holes.map(({ id, source, x, y, H, dia, depth, blind, insert, sink }) =>
        ({ id, source, x, y, H, dia, depth, blind, insert, sink })),
      order: S.order,
    };
    download(`${S.name}.ipjob.json`, JSON.stringify(job, null, 2), 'application/json');
    toast('Saved job file.');
  }

  function openJob(text) {
    let job;
    try { job = JSON.parse(text); } catch (e) { toast('That job file is not valid JSON.', true); return; }
    if (job.format !== 'insertpress-job') { toast('That file is not an InsertPress job.', true); return; }
    if (!S.raw || (job.part && S.raw.length / 9 !== job.part.triangles)) {
      S.pendingJob = job;
      toast(`Job loaded. Now open ${job.part ? job.part.name + '.stl' : 'its STL'}.`);
      return;
    }
    applyJob(job);
  }

  function applyJob(job) {
    if (job.part && S.raw.length / 9 !== job.part.triangles) {
      toast('This STL has a different triangle count than the job expects. Holes may not line up.', true);
    }
    S.settings = Object.assign({}, IP.DEFAULT_SETTINGS, job.settings || {});
    saveSettings();
    renderSettings();
    viewer.setBed(S.settings.bedX, S.settings.bedY);
    S.rot = (job.part && job.part.rot) || { x: 0, y: 0, z: 0 };
    setUnits((job.part && job.part.scale) || 1, false);
    S.part = IP.stl.preparePart(S.raw, { rot: S.rot, scale: S.scale });
    viewer.setPart(S.part.positions, S.part.size);
    onPartReady();
    S.holes = (job.holes || []).map((h) => Object.assign({}, h));
    S.order = (job.order || []).filter((id) => S.holes.some((h) => h.id === id));
    S.nextId = Math.max(0, ...S.holes.map((h) => h.id)) + 1;
    S.ignored = [];
    detect(true);
    goStep('holes');
    toast('Opened job.');
  }

  /* ---------- settings form ---------- */
  function renderSettings() {
    const s = S.settings;
    const html = SCHEMA.map((g) => `<div class="group"><h3>${g.group}</h3>${g.items.map((it) => {
      const id = 'set-' + it.key;
      const help = it.help ? `<div class="help">${esc(it.help)}</div>` : '';
      let ctl;
      if (it.type === 'select' || it.type === 'insert') {
        const opts = it.type === 'insert'
          ? insertOptions(s[it.key])
          : it.options.map(([v, l]) => `<option value="${v}"${v === s[it.key] ? ' selected' : ''}>${esc(l)}</option>`).join('');
        ctl = `<select id="${id}" data-key="${it.key}">${opts}</select>`;
      } else if (it.type === 'bool') {
        ctl = `<span class="switch"><input type="checkbox" role="switch" id="${id}" data-key="${it.key}"${s[it.key] ? ' checked' : ''}><span></span></span>`;
      } else {
        ctl = `<span class="num-in"><input type="number" id="${id}" data-key="${it.key}" step="${it.step}" value="${s[it.key]}"><span>${it.unit}</span></span>`;
      }
      return `<div class="set"><label for="${id}">${it.label}</label>${ctl}${help}</div>`;
    }).join('')}</div>`).join('');
    $('pane-machine').innerHTML = html + '<button class="btn small" id="btn-reset">Restore defaults</button>';
  }

  function onSetting(e) {
    const el = e.target;
    const key = el.dataset.key;
    if (!key) return;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'number') { v = parseFloat(el.value); if (!isFinite(v)) return; }
    else v = el.value;
    S.settings[key] = v;
    saveSettings();
    if (key === 'bedX' || key === 'bedY') viewer.setBed(S.settings.bedX, S.settings.bedY);
    if (key === 'dMin' || key === 'dMax') { detect(true); return; }
    refresh();
  }

  /* ---------- events ---------- */
  $('file-stl').addEventListener('change', (e) => { readFile(e.target.files[0]); e.target.value = ''; });
  $('file-job').addEventListener('change', (e) => { readFile(e.target.files[0]); e.target.value = ''; });
  $('btn-example').addEventListener('click', loadExample);
  $('btn-save-job').addEventListener('click', saveJob);
  $('btn-save-job-2').addEventListener('click', saveJob);
  $('btn-export').addEventListener('click', exportGcode);
  $('btn-export-2').addEventListener('click', exportGcode);
  $('btn-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(S.result.text); toast('Copied G-code.'); }
    catch (e) { toast('Copy is blocked here. Use Download G-code instead.', true); }
  });

  $$('.step').forEach((b) => b.addEventListener('click', () => goStep(b.dataset.step)));
  $('btn-next').addEventListener('click', () => goStep(STEPS[Math.min(STEPS.indexOf(S.step) + 1, STEPS.length - 1)]));
  $('btn-back').addEventListener('click', () => goStep(STEPS[Math.max(STEPS.indexOf(S.step) - 1, 0)]));

  $$('[data-rot]').forEach((b) => b.addEventListener('click', () => {
    if (!S.raw) return;
    const had = S.order.length;
    S.rot[b.dataset.rot] = (S.rot[b.dataset.rot] + 1) % 4;
    rebuild();
    const n = S.holes.length;
    toast(`${n} hole${n === 1 ? '' : 's'} face up now.${had ? ' The press order was cleared.' : ''}`);
  }));
  $$('[data-units]').forEach((b) => b.addEventListener('click', () => setUnits(+b.dataset.units, true)));

  $('btn-all').addEventListener('click', () => {
    for (const h of S.holes) if (!S.order.includes(h.id)) S.order.push(h.id);
    refresh();
  });
  $('btn-none').addEventListener('click', () => { S.order = []; S.activeId = null; refresh(); });
  $('btn-optimize').addEventListener('click', () => {
    if (S.order.length < 3) { toast('Add at least three holes to reorder.'); return; }
    const s = S.settings;
    const start = s.mode === 'xy' && s.park ? [s.parkX, s.parkY] : [0, 0];
    S.order = IP.gcode.optimizeOrder(S.order.map(byId), start[0], start[1]).map((h) => h.id);
    refresh();
    toast('Reordered for the shortest travel.');
  });
  $('btn-add').addEventListener('click', () => setAddMode(!S.addMode));
  $$('[data-view]').forEach((b) => b.addEventListener('click', () => viewer.frame(b.dataset.view)));
  $('btn-path').addEventListener('click', (e) => {
    const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    e.currentTarget.setAttribute('aria-pressed', String(on));
    viewer.setPathVisible(on);
  });

  // hole lists
  $('order-list').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) { toggleOrder(+rm.dataset.remove); return; }
    if (e.target.closest('select, input, label')) return;
    const li = e.target.closest('.hole');
    if (!li) return;
    const id = +li.dataset.id;
    S.activeId = S.activeId === id ? null : id;
    renderHoles(); updateView();
  });
  $('order-list').addEventListener('change', (e) => {
    const sel = e.target.closest('[data-insert]');
    if (sel) { byId(+sel.dataset.insert).insert = sel.value; refresh(); return; }
    const sk = e.target.closest('[data-sink]');
    if (sk) {
      const v = parseFloat(sk.value);
      byId(+sk.dataset.sink).sink = isFinite(v) ? v : null;
      refresh();
    }
  });
  $('unused-list').addEventListener('click', (e) => {
    const del = e.target.closest('[data-delete]');
    if (del) { S.holes = S.holes.filter((h) => h.id !== +del.dataset.delete); refresh(); return; }
    const li = e.target.closest('[data-add]');
    if (li) toggleOrder(+li.dataset.add);
  });
  ['order-list', 'unused-list'].forEach((lid) => {
    $(lid).addEventListener('mouseover', (e) => {
      const li = e.target.closest('.hole');
      const id = li ? +(li.dataset.id || li.dataset.add) : null;
      if (id !== S.hoverId) { S.hoverId = id; updateView(); }
    });
    $(lid).addEventListener('mouseleave', () => { S.hoverId = null; updateView(); });
  });

  // drag to reorder
  let dragId = null;
  const ol = $('order-list');
  ol.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.hole');
    if (!li) return;
    dragId = +li.dataset.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragId));
  });
  ol.addEventListener('dragover', (e) => {
    if (dragId == null) return;
    e.preventDefault();
    ol.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
    const li = e.target.closest('.hole');
    if (!li) return;
    const r = li.getBoundingClientRect();
    li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  ol.addEventListener('drop', (e) => {
    e.preventDefault();
    const li = e.target.closest('.hole');
    if (dragId == null || !li) return;
    const target = +li.dataset.id;
    if (target !== dragId) {
      const after = li.classList.contains('drop-after');
      S.order.splice(S.order.indexOf(dragId), 1);
      S.order.splice(S.order.indexOf(target) + (after ? 1 : 0), 0, dragId);
    }
    dragId = null;
    refresh();
  });
  ol.addEventListener('dragend', () => {
    dragId = null;
    ol.querySelectorAll('.dragging, .drop-before, .drop-after').forEach((n) => n.classList.remove('dragging', 'drop-before', 'drop-after'));
  });

  // settings
  $('pane-machine').addEventListener('change', onSetting);
  $('pane-machine').addEventListener('click', (e) => {
    if (e.target.id !== 'btn-reset') return;
    S.settings = Object.assign({}, IP.DEFAULT_SETTINGS);
    saveSettings(); renderSettings();
    viewer.setBed(S.settings.bedX, S.settings.bedY);
    if (S.part) detect(true);
    toast('Restored default settings.');
  });

  // drag and drop files
  let dragDepth = 0;
  const isFileDrag = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!isFileDrag(e)) return; dragDepth++; $('drop-veil').hidden = false; });
  window.addEventListener('dragleave', (e) => { if (!isFileDrag(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('drop-veil').hidden = true; } });
  window.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    dragDepth = 0; $('drop-veil').hidden = true;
    readFile(e.dataTransfer.files[0]);
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.closest && e.target.closest('input, select')) return;
    if (e.key === 'Escape' && S.addMode) setAddMode(false);
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.activeId != null && S.order.includes(S.activeId)) {
      toggleOrder(S.activeId);
    }
  });

  renderSettings();
  goStep('part');
})();
