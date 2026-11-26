// GROUNDWATCH · offline dashboard. window.RADAR is the only input; textContent is the only writer.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var ROWS = Array.isArray(DATA.rows) ? DATA.rows : [];
  var KPI = DATA.kpi || {};
  var state = { q: '', category: 'all', chain: 'all', verdict: 'all', watchOnly: false, sortKey: 'rank', sortDir: 'asc' };
  var selected = null;

  function byId(id) { return document.getElementById(id); }
  function put(id, value) { var node = byId(id); if (node) node.textContent = String(value); }
  function el(tag, cls, value) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (value !== undefined && value !== null) node.textContent = String(value);
    return node;
  }

  // Plain, locale-free formatting: two runs of this code always spell the same digits.
  function grouped(n) {
    var s = String(Math.round(Number(n) || 0)), out = '', i = s.length;
    while (i > 3) { out = ',' + s.slice(i - 3, i) + out; i -= 3; }
    return s.slice(0, i) + out;
  }
  function compact(n) {
    if (typeof n !== 'number' || !isFinite(n)) return 'n/a';
    var a = Math.abs(n);
    if (a >= 1e12) return '$' + (n / 1e12).toFixed(1) + 'T';
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + grouped(n);
  }
  function implied(n) { return '$' + grouped(Number(n) / 1e6) + 'M'; }
  function pct(fraction) { return (Number(fraction) * 100).toFixed(1) + '%'; }
  function change(n) {
    if (typeof n !== 'number' || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function money(n) { return '$' + Number(n || 0).toFixed(2); }
  function hours(n) { return String(Number(n || 0)) + ' h'; }
  function badge(label, cls) { return el('span', 'badge ' + cls, label); }
  function verdictClass(v) { return 'verdict-' + String(v || '').toLowerCase(); }
  function formatChains(chains) {
    var list = Array.isArray(chains) ? chains.filter(function (c) { return typeof c === 'string' && c; }) : [];
    if (!list.length) return '—';
    if (list.length <= 2) return list.join(', ');
    return list[0] + ', ' + list[1] + ' +' + (list.length - 2);
  }

  function renderKpi() {
    var nodes = document.querySelectorAll('[data-kpi]');
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-kpi');
      var value = key === 'generated_at_utc' ? DATA.generated_at_utc : KPI[key];
      if (value === undefined || value === null) continue;
      if (key === 'walkforward_mape' || key === 'loo_mape') value = pct(value);
      else if (key === 'rmsle') value = Number(value).toFixed(3);
      else if (key === 'min_value' || key === 'max_value') value = compact(value);
      else if (typeof value === 'number') value = grouped(value);
      nodes[i].textContent = String(value);
    }
  }

  function options(id, values) {
    var select = byId(id);
    if (!select) return;
    values.forEach(function (v) {
      var option = el('option', null, v);
      option.value = v;
      select.appendChild(option);
    });
  }
  function valuesFor(field) {
    var seen = Object.create(null), out = [];
    ROWS.forEach(function (r) {
      var list = field === 'chain' ? (r.chains || []) : [r.category];
      list.forEach(function (v) {
        if (typeof v === 'string' && v && !seen[v]) { seen[v] = true; out.push(v); }
      });
    });
    return out.sort();
  }

  var FIELDS = { rank: 'rank', implied: 'implied_value_usd', tvl: 'tvl_usd', growth: 'change_7d', age: 'age_days', odds: 'token_odds', yield: 'yield_usd_per_day' };
  function matches(r) {
    var q = state.q.trim().toLowerCase();
    if (q && String(r.name || '').toLowerCase().indexOf(q) < 0 && String(r.slug || '').toLowerCase().indexOf(q) < 0) return false;
    if (state.category !== 'all' && r.category !== state.category) return false;
    if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
    if (state.verdict !== 'all' && r.verdict !== state.verdict) return false;
    if (state.watchOnly && !r.on_watchlist) return false;
    return true;
  }
  function ordered() {
    var key = state.sortKey, field = FIELDS[key] || 'rank', sign = state.sortDir === 'asc' ? 1 : -1;
    return ROWS.filter(matches).sort(function (a, b) {
      var av = key === 'name' ? String(a.name || '').toLowerCase() : a[field];
      var bv = key === 'name' ? String(b.name || '').toLowerCase() : b[field];
      if (av === null || av === undefined || !isFinite(av)) av = Infinity;
      if (bv === null || bv === undefined || !isFinite(bv)) bv = Infinity;
      if (av === bv) return a.rank - b.rank;
      if (av === Infinity) return 1;
      if (bv === Infinity) return -1;
      return av < bv ? -sign : sign;
    });
  }

  function renderBoard() {
    var list = ordered(), body = byId('board-body');
    if (!body) return;
    body.textContent = '';
    put('row-count', list.length + (list.length === 1 ? ' row' : ' rows'));
    var dir = byId('sort-dir');
    if (dir) {
      dir.textContent = state.sortDir === 'asc' ? '↑ asc' : '↓ desc';
      dir.setAttribute('data-dir', state.sortDir);
      dir.setAttribute('aria-label', 'Sort direction: ' + state.sortDir + ', activate to reverse');
    }
    if (!list.length) {
      var empty = el('tr', 'empty');
      var cell = el('td', null, 'No protocols match these filters. Clear the search or change a filter to see the board.');
      cell.colSpan = 11;
      empty.appendChild(cell);
      body.appendChild(empty);
      return;
    }
    list.forEach(function (r) {
      var tr = el('tr');
      tr.tabIndex = 0;
      tr.setAttribute('data-slug', r.slug);
      if (selected === r.slug) tr.setAttribute('data-selected', 'true');
      tr.addEventListener('click', function () { renderDetail(r.slug); });
      tr.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); renderDetail(r.slug); }
      });
      tr.appendChild(el('td', 'num', r.rank));
      var protocol = el('td', 'protocol-cell'), name = el('div', 'protocol', r.name);
      name.appendChild(el('div', 'sub', r.slug));
      protocol.appendChild(name);
      tr.appendChild(protocol);
      tr.appendChild(el('td', null, r.category || '—'));
      tr.appendChild(el('td', 'chains', formatChains(r.chains)));
      tr.appendChild(el('td', 'num', compact(r.tvl_usd)));
      var tone = typeof r.change_7d === 'number' ? (r.change_7d >= 0 ? 'pos' : 'neg') : '';
      tr.appendChild(el('td', 'num ' + tone, change(r.change_7d)));
      tr.appendChild(el('td', 'num', grouped(r.age_days) + 'd'));
      tr.appendChild(el('td', 'num', pct(r.token_odds)));
      tr.appendChild(el('td', 'num', implied(r.implied_value_usd)));
      var verdict = el('td');
      verdict.appendChild(badge(r.verdict, verdictClass(r.verdict)));
      verdict.appendChild(document.createTextNode(' '));
      verdict.appendChild(badge(r.on_watchlist ? 'watchlist' : 'off', r.on_watchlist ? 'on-watchlist' : 'off-watchlist'));
      tr.appendChild(verdict);
      tr.appendChild(el('td', 'num', money(r.yield_usd_per_day)));
      body.appendChild(tr);
    });
  }

  function rowFor(slug) {
    for (var i = 0; i < ROWS.length; i++) if (ROWS[i].slug === slug) return ROWS[i];
    return null;
  }
  function planRow(label, valueA, valueB) {
    var tr = el('tr'), th = el('th', null, label);
    th.setAttribute('scope', 'row');
    tr.appendChild(th);
    tr.appendChild(el('td', null, valueA));
    tr.appendChild(el('td', null, valueB));
    return tr;
  }
  function renderDetail(slug) {
    var r = rowFor(slug);
    if (!r) return;
    selected = slug;
    put('detail-rank', 'Rank ' + r.rank);
    put('detail-title', r.name);
    put('detail-slug', r.slug);
    var v = byId('detail-verdict');
    if (v) { v.textContent = r.verdict; v.className = 'badge ' + verdictClass(r.verdict); }
    var w = byId('detail-watchlist');
    if (w) {
      w.textContent = r.on_watchlist ? 'on watchlist' : 'off watchlist';
      w.className = 'badge ' + (r.on_watchlist ? 'on-watchlist' : 'off-watchlist');
    }
    put('factor-chains', formatChains(r.chains));
    put('factor-tvl', compact(r.tvl_usd));
    put('factor-growth', change(r.change_7d));
    put('factor-age', grouped(r.age_days) + ' days');
    put('factor-odds', pct(r.token_odds));
    put('factor-implied', implied(r.implied_value_usd));

    var plan = byId('detail-plan');
    if (plan) {
      plan.textContent = '';
      (r.farm_steps || []).forEach(function (step, i) {
        var tr = el('tr'), th = el('th', null, 'Step ' + (i + 1));
        th.setAttribute('scope', 'row');
        tr.appendChild(th);
        var td = el('td', null, step);
        td.colSpan = 2;
        tr.appendChild(td);
        plan.appendChild(tr);
      });
      plan.appendChild(planRow('Plan totals', '$' + grouped(r.farm_cost_usd) + ' cost · ' + money(r.yield_usd_per_day) + '/day', hours(r.farm_hours) + ' · ' + r.verdict));
    }
    put('detail-yield', r.verdict + ': ' + money(r.yield_usd_per_day) + ' per day against $' + grouped(r.farm_cost_usd) + ' of cost and ' + hours(r.farm_hours) + ' of work.');
    put('detail-audit', 'model audit: walk-forward MAPE ' + pct(r.mape_walkforward) + ', LOO MAPE ' + pct(r.mape_loo) + ' (fitLaunchValue on ' + grouped(KPI.traded_n) + ' traded protocols)');
    var rmsle = Number(r.rmsle);
    put('detail-rmsle', isFinite(rmsle) ? 'rmsle ' + rmsle.toFixed(3) + ' · cleaned ' + grouped(r.n_clean) + ' · dropped ' + grouped(r.n_dropped) : 'rmsle —');
    var drawer = byId('detail');
    if (drawer) { drawer.hidden = false; drawer.setAttribute('aria-hidden', 'false'); }
    renderBoard();
  }
  function closeDetail() {
    var drawer = byId('detail');
    if (drawer) { drawer.hidden = true; drawer.setAttribute('aria-hidden', 'true'); }
    selected = null;
    renderBoard();
  }

  function bind() {
    var search = byId('search');
    if (search) search.addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); });
    [['filter-category', 'category'], ['filter-chain', 'chain'], ['filter-verdict', 'verdict']].forEach(function (pair) {
      var node = byId(pair[0]);
      if (node) node.addEventListener('change', function (e) { state[pair[1]] = e.target.value; renderBoard(); });
    });
    var watch = byId('watchlist-only');
    if (watch) watch.addEventListener('change', function (e) { state.watchOnly = !!e.target.checked; renderBoard(); });
    var sort = byId('sort-by');
    if (sort) sort.addEventListener('change', function (e) { state.sortKey = e.target.value; renderBoard(); });
    var dir = byId('sort-dir');
    if (dir) dir.addEventListener('click', function () { state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc'; renderBoard(); });
    var close = byId('detail-close');
    if (close) close.addEventListener('click', closeDetail);
    document.addEventListener('keydown', function (e) {
      var drawer = byId('detail');
      if (e.key === 'Escape' && drawer && !drawer.hidden) closeDetail();
    });
  }

  options('filter-category', valuesFor('category'));
  options('filter-chain', valuesFor('chain'));
  bind();
  renderKpi();
  renderBoard();

  window.GROUNDWATCH = { state: state, renderKpi: renderKpi, renderBoard: renderBoard, renderDetail: renderDetail, closeDetail: closeDetail };
})();
