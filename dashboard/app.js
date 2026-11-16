// TOKEN RADAR dashboard — reads window.RADAR from data.js, renders the ranked board,
// filters, per-protocol detail with the model's step-by-step arithmetic, the live-token
// set-aside, and a plain-English model explainer. No network: every byte shown is in data.js.
(function () {
  'use strict';
  var DATA = window.RADAR;
  var app = document.getElementById('app');
  if (!DATA || !Array.isArray(DATA.rows)) {
    app.innerHTML = '<div class="shell"><p class="loading">No board data: data.js did not set window.RADAR.</p></div>';
    return;
  }
  var M = DATA.model || {};
  var BASE = typeof M.base_multiple === 'number' ? M.base_multiple : 0.25;
  var GW = typeof M.growth_weight === 'number' ? M.growth_weight : 0.5;
  // radar-4 constants: growth saturates through tanh, maturity is a log curve,
  // and each ratio is a shrinkage blend over TVL-band comparables.
  var GTS = typeof M.growth_tanh_scale === 'number' ? M.growth_tanh_scale : 50;
  var SK = typeof M.shrinkage_k === 'number' ? M.shrinkage_k : 3;
  var BF = typeof M.tvl_band_factor === 'number' ? M.tvl_band_factor : 10;
  var BM = typeof M.band_min_comps === 'number' ? M.band_min_comps : 2;
  var WP = typeof M.winsorize_percentile === 'number' ? M.winsorize_percentile : 0.95;
  var WC = typeof M.winsorize_cap === 'number' ? M.winsorize_cap : null;
  var MF = typeof M.maturity_floor === 'number' ? M.maturity_floor : 0.6;
  var MR = typeof M.maturity_range === 'number' ? M.maturity_range : 0.4;
  var MD = typeof M.maturity_days === 'number' ? M.maturity_days : 1095;
  var UA = typeof M.unknown_age_days === 'number' ? M.unknown_age_days : 365;
  var CW = typeof M.chain_log_weight === 'number' ? M.chain_log_weight : 0.05;
  var CC = typeof M.chain_multiplier_cap === 'number' ? M.chain_multiplier_cap : 1.15;
  var WATCH = new Set(Array.isArray(DATA.watchlist) ? DATA.watchlist : DATA.rows.filter(function (r) { return r.tvl_usd >= (DATA.floor_usd || 0); }).map(function (r) { return r.slug; }));
  var MAXTVL = Math.max.apply(null, DATA.rows.map(function (r) { return r.tvl_usd; }).concat([1]));
  // A plain TVL sort, for the "what the model changes" comparison: each row's
  // position if the board were ranked by TVL alone. delta(r) is how many places
  // the model moves a protocol up (positive) or down (negative) from that sort.
  var TVLRANK = {};
  DATA.rows.slice().sort(function (a, b) { return b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1); })
    .forEach(function (r, i) { TVLRANK[r.slug] = i + 1; });
  function delta(r) { return (TVLRANK[r.slug] || r.rank) - r.rank; }
  function deltaText(r) { var d = delta(r); return d > 0 ? '\u25B2' + d : d < 0 ? '\u25BC' + (-d) : '\u2014'; }

  var state = { q: '', cat: 'all', chain: 'all', minTvl: 0, wl: false, pre: false, sort: 'implied', dir: -1, sel: null };

  function $(t, a) {
    var n = document.createElement(t);
    if (a) Object.keys(a).forEach(function (k) {
      if (k === 'class') n.className = a[k];
      else if (k === 'text') n.textContent = a[k];
      else if (k === 'html') n.innerHTML = a[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), a[k]);
      else if (a[k] !== null && a[k] !== undefined) n.setAttribute(k, a[k]);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) n.appendChild(x); });
      else if (typeof c === 'string') n.appendChild(document.createTextNode(c));
      else n.appendChild(c);
    }
    return n;
  }
  function usd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function usdFull(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function pct(n) { return (n === null || n === undefined || !isFinite(n)) ? 'n/a' : (n > 0 ? '+' : '') + n.toFixed(2) + '%'; }
  function age(d) {
    if (d === null || d === undefined) return 'unknown';
    if (d >= 365) return (d / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(d)) + 'd';
  }
  function mdl(r) {
    var raw = (typeof r.change_7d === 'number') ? r.change_7d : 0;
    var changeKnown = typeof r.change_7d === 'number';
    // radar-3 stores the exact multipliers on each row (category ratio, growth,
    // maturity, chain). Recompute from those stored figures: the board's implied
    // value is round(base x gm x mm x cm), and only the stored figures reproduce
    // it — one global multiple cannot, because each protocol is priced against
    // its own TVL band and each protocol has its own chain count. Fallbacks use
    // the radar-3 formulas (tanh growth, log maturity) for older data.js files
    // that carry no stored multipliers.
    var ratio = (typeof r.category_ratio === 'number') ? r.category_ratio : BASE;
    var base = (typeof r.base === 'number') ? r.base : r.tvl_usd * ratio;
    var gm = (typeof r.growth_multiplier === 'number') ? r.growth_multiplier : 1 + GW * Math.tanh(raw / GTS);
    var a = (r.age_days === null || r.age_days === undefined) ? UA : r.age_days;
    var mm = (typeof r.maturity_multiplier === 'number') ? r.maturity_multiplier : MF + MR * Math.log(1 + Math.min(Math.max(a, 0), MD)) / Math.log(1 + MD);
    var cm = (typeof r.chain_multiplier === 'number') ? r.chain_multiplier : 1;
    return { raw: raw, changeKnown: changeKnown, gm: gm, ageUsed: a, ageKnown: r.age_days !== null && r.age_days !== undefined, mm: mm, cm: cm, ratio: ratio, base: base, implied: Math.max(1, Math.round(base * gm * mm * cm)) };
  }
  function isPre(r) { return r.mcap_usd === null || r.mcap_usd === undefined; }
  // Fallback farm plan (only if a row carries no farm_steps): derived from category, chain, TVL, age.
  function deriveSteps(r) {
    var chain = (r.chains && r.chains[0]) || 'its main chain';
    var cap = r.tvl_usd >= 5e9 ? 250 : r.tvl_usd >= 1e9 ? 150 : r.tvl_usd >= 1e8 ? 100 : 50;
    var hold = (r.age_days === null || r.age_days === undefined) ? 30 : r.age_days < 180 ? 60 : r.age_days < 365 ? 45 : 30;
    var c = (r.category || '').toLowerCase();
    var act;
    if (/lend|cdp|collateral/.test(c)) act = 'Supply $' + cap + ' of USDC to ' + r.name + ' on ' + chain + ' and keep the position open.';
    else if (/dex|yield|leveraged farm/.test(c)) act = 'Provide $' + cap + ' of liquidity to ' + r.name + "'s main pool on " + chain + ' and keep the position open.';
    else if (/bridge/.test(c)) act = 'Bridge $' + cap + ' of USDC to ' + chain + ' through ' + r.name + ' and use the bridged funds in its app.';
    else if (/staking|restak/.test(c)) act = 'Stake $' + cap + " of the chain's staking asset through " + r.name + ' and keep the receipt.';
    else if (/perpetual|derivative/.test(c)) act = 'Deposit $' + cap + ' of USDC as margin on ' + r.name + ' and open one small hedge.';
    else act = 'Deposit $' + cap + ' of USDC into ' + r.name + ' on ' + chain + ' and keep the position open.';
    return [
      'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline. Cost: under $3 of gas for the first transaction. Time: 5 minutes.',
      act + ' Cost: $' + cap + ' of capital and about $' + (cap >= 150 ? 8 : 4) + ' of gas. Time: 15 minutes to set up.',
      'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote. Cost: about $2 of gas a week. Time: 10 minutes a week.',
      'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot. Cost: the $' + cap + ' stays in the position. Time: ' + hold + ' days.',
      "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes. Cost: no fee to check, and never pay to claim. Time: 10 minutes.",
      'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it. Cost: nothing but the log. Time: 5 minutes.'
    ];
  }
  function stepsOf(r) { return (Array.isArray(r.farm_steps) && r.farm_steps.length) ? r.farm_steps : deriveSteps(r); }
  function splitStep(s) {
    var ci = s.indexOf(' Cost: '), ti = s.indexOf(' Time: ');
    if (ci < 0) return { act: s, tail: '' };
    var tail = s.slice(ci + 1);
    return { act: s.slice(0, ci), tail: tail };
  }

  function readHash() {
    var h = window.location.hash.replace(/^#/, '');
    if (!h) return;
    var p = new URLSearchParams(h);
    if (p.get('q')) state.q = p.get('q');
    if (p.get('cat')) state.cat = p.get('cat');
    if (p.get('chain')) state.chain = p.get('chain');
    if (p.get('tvl')) state.minTvl = +p.get('tvl') || 0;
    if (p.get('wl') === '1') state.wl = true;
    if (p.get('pre') === '1') state.pre = true;
    if (p.get('sort')) state.sort = p.get('sort');
    if (p.get('dir')) state.dir = +p.get('dir') || -1;
    if (p.get('p')) state.sel = p.get('p');
  }
  function writeHash() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.cat !== 'all') p.set('cat', state.cat);
    if (state.chain !== 'all') p.set('chain', state.chain);
    if (state.minTvl > 0) p.set('tvl', String(state.minTvl));
    if (state.wl) p.set('wl', '1');
    if (state.pre) p.set('pre', '1');
    if (state.sort !== 'implied') p.set('sort', state.sort);
    if (state.dir !== -1) p.set('dir', String(state.dir));
    if (state.sel) p.set('p', state.sel);
    var s = p.toString();
    window.history.replaceState(null, '', s ? '#' + s : window.location.pathname + window.location.search);
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.cat !== 'all' && (r.category || 'Other') !== state.cat) return false;
      if (state.chain !== 'all' && !(r.chains || []).includes(state.chain)) return false;
      if (r.tvl_usd < state.minTvl) return false;
      if (state.wl && !WATCH.has(r.slug)) return false;
      if (state.pre && !isPre(r)) return false;
      if (!q) return true;
      return [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase().indexOf(q) >= 0;
    });
  }
  function sorted(list) {
    var k = state.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (k === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (k === 'cat') { av = (a.category || '').toLowerCase(); bv = (b.category || '').toLowerCase(); }
      else if (k === 'chain') { av = (a.chains && a.chains[0]) || ''; bv = (b.chains && b.chains[0]) || ''; }
      else if (k === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (k === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (k === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else if (k === 'rank') { av = a.rank; bv = b.rank; }
      else if (k === 'delta') { av = delta(a); bv = delta(b); }
      else if (k === 'multiple') { av = a.implied_value_usd / a.tvl_usd; bv = b.implied_value_usd / b.tvl_usd; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : 1;
    });
  }

  function head() {
    return $('header', { class: 'top' },
      $('div', { class: 'brand' }, $('span', { class: 'mark', 'aria-hidden': 'true' }), $('span', { class: 'brand-name', text: 'TOKEN\u00A0RADAR' })),
      $('div', { class: 'top-meta' },
        $('span', { text: 'snapshot ' + DATA.as_of }),
        $('span', { text: 'DefiLlama protocol index' }),
        $('span', { text: (DATA.model_version || 'radar-1') + ' model' }),
        $('span', { text: 'floor ' + usd(DATA.floor_usd) })
      ));
  }
  function lede() {
    var wlN = DATA.watchlist_size || WATCH.size;
    var early = (DATA.early_size !== undefined) ? DATA.early_size : DATA.rows.length - wlN;
    return $('section', { class: 'lede' },
      $('div', null,
        $('h1', { text: wlN + ' watchlist protocols, ranked by implied value' }),
        $('p', { html: 'The watchlist is the floor, never the ceiling: every protocol with at least <b>' + usd(DATA.floor_usd) + '</b> of TVL that records no token. The early radar adds <b>' + early + '</b> pre-token protocols below that floor. Implied value is a model of what a token would be worth if the protocol\u2019s record stayed as it is \u2014 not a promise, and not a prediction of whether or when a token is issued.' })
      ),
      $('div', { class: 'facts' },
        $('div', { class: 'fact' }, $('span', { text: 'Watchlist covered' }), $('b', { text: wlN + ' / ' + wlN })),
        $('div', { class: 'fact' }, $('span', { text: 'Pre-token rows ranked' }), $('b', { text: String(DATA.rows.length) })),
        $('div', { class: 'fact' }, $('span', { text: 'Early rows below the floor' }), $('b', { text: String(early) })),
        $('div', { class: 'fact' }, $('span', { text: 'Live-token protocols set aside' }), $('b', { text: String((DATA.live || []).length) })),
        $('div', { class: 'fact' }, $('span', { text: 'Top implied value' }), $('b', { text: usd(DATA.rows[0] ? DATA.rows[0].implied_value_usd : 0) }))
      ));
  }
  function controls() {
    var cats = DATA.categories || Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chains = DATA.chains || Array.from(new Set(DATA.rows.reduce(function (a, r) { return a.concat(r.chains || []); }, []))).sort();
    var search = $('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; writeHash(); render(); });
    var catSel = $('select', { id: 'cat', 'aria-label': 'Filter by category' },
      $('option', { value: 'all', text: 'All categories' }),
      cats.map(function (c) { return $('option', { value: c, text: c, selected: c === state.cat ? 'selected' : null }); }));
    catSel.addEventListener('change', function () { state.cat = catSel.value; writeHash(); render(); });
    var chSel = $('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      $('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return $('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); }));
    chSel.addEventListener('change', function () { state.chain = chSel.value; writeHash(); render(); });
    var rng = $('input', { type: 'range', id: 'tvl', min: '0', max: String(MAXTVL), step: '10000000', value: String(state.minTvl), 'aria-label': 'Minimum TVL' });
    var rngVal = $('span', { class: 'num muted', id: 'tvl-val', text: state.minTvl > 0 ? '\u2265 ' + usd(state.minTvl) : 'any TVL' });
    rng.addEventListener('input', function () { state.minTvl = +rng.value; rngVal.textContent = state.minTvl > 0 ? '\u2265 ' + usd(state.minTvl) : 'any TVL'; writeHash(); render(); });
    function tgl(label, on, fn) {
      var b = $('button', { type: 'button', class: 'tgl', 'aria-pressed': on ? 'true' : 'false', text: label, onclick: function () { fn(); render(); } });
      return b;
    }
    var wlBtn = tgl('Watchlist only', state.wl, function () { state.wl = !state.wl; writeHash(); });
    var preBtn = tgl('Pre-token only', state.pre, function () { state.pre = !state.pre; writeHash(); });
    return $('div', { class: 'controls' },
      $('div', { class: 'field' }, $('label', { for: 'q', text: 'Search' }), search),
      $('div', { class: 'field' }, $('label', { for: 'cat', text: 'Category' }), catSel),
      $('div', { class: 'field' }, $('label', { for: 'chain', text: 'Chain' }), chSel),
      $('div', { class: 'field' }, $('label', { for: 'tvl', text: 'Min TVL' }), rng, rngVal),
      $('div', { class: 'toggles' }, wlBtn, preBtn),
      $('span', { class: 'count', id: 'count', text: '' })
    );
  }
  function sortTh(key, label) {
    var arrow = state.sort === key ? $('span', { class: 'arr', 'aria-hidden': 'true', text: state.dir < 0 ? ' \u25BC' : ' \u25B2' }) : null;
    return $('th', { scope: 'col' },
      $('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } writeHash(); render(); } }, label, arrow));
  }
  function boardTable() {
    var list = sorted(filtered());
    var cnt = document.getElementById('count');
    if (cnt) cnt.textContent = list.length + ' of ' + DATA.rows.length + ' rows';
    if (!list.length) {
      return $('div', { class: 'panel' }, $('div', { class: 'empty' },
        $('h2', { text: 'No protocol matches that filter' }),
        $('p', { text: 'Clear the search, lower the TVL floor or pick another category to see the board again.' }),
        $('button', { class: 'btn primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.cat = 'all'; state.chain = 'all'; state.minTvl = 0; state.wl = false; state.pre = false; writeHash(); render(); } })
      ));
    }
    var max = list[0].implied_value_usd || 1;
    var tb = $('tbody');
    list.forEach(function (r) {
      var g = r.change_7d;
      var tr = $('tr', {
        'data-sel': state.sel === r.slug ? 'true' : 'false', tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        $('td', { class: 'num', text: String(r.rank) }),
        $('td', null, $('div', { class: 'name' },
          $('b', { text: r.name + (WATCH.has(r.slug) ? ' \u2605' : '') }),
          $('span', { text: (r.category || 'Other') + ' \u00B7 ' + (r.listed_at || 'listed date unknown') })
        )),
        $('td', { class: 'num', text: usd(r.tvl_usd) }),
        $('td', { class: 'num ' + (g === null ? '' : g >= 0 ? 'pos' : 'neg'), text: pct(g) }),
        $('td', { class: 'num', text: age(r.age_days) }),
        $('td', null, $('div', { class: 'imp' },
          $('div', { class: 'bar', 'aria-hidden': 'true' }, $('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          $('span', { class: 'num', text: usd(r.implied_value_usd) })
        )),
        $('td', { class: 'num', title: 'Implied value / TVL: the multiple the model actually used for this row', text: (r.tvl_usd > 0 ? '\u00D7' + (r.implied_value_usd / r.tvl_usd).toFixed(2) : 'n/a') }),
        $('td', { class: 'num ' + (delta(r) > 0 ? 'pos' : delta(r) < 0 ? 'neg' : 'dim'), title: 'TVL rank ' + TVLRANK[r.slug] + ' \u2192 implied rank ' + r.rank, text: deltaText(r) }),
        $('td', null, $('span', { class: 'tag' + (WATCH.has(r.slug) ? ' watch' : ''), text: WATCH.has(r.slug) ? 'watchlist' : 'pre-token' }))
      );
      tb.appendChild(tr);
    });
    return $('div', { class: 'panel' }, $('div', { class: 'table-wrap' },
      $('table', null,
        $('caption', { text: 'Pre-token protocols, strongest implied value first. Multiple is implied value / TVL, the multiple the model actually used. \u0394 vs TVL shows how many places the model moves a protocol from a plain TVL sort. Select a row for its model arithmetic and farm plan. \u2605 marks the watchlist.' }),
        $('thead', null, $('tr', null,
          sortTh('rank', 'Rank'), sortTh('name', 'Protocol'), sortTh('tvl', 'TVL'), sortTh('growth', '7d'), sortTh('age', 'Age'), sortTh('implied', 'Implied value'), sortTh('multiple', 'Multiple'), sortTh('delta', '\u0394 vs TVL'), $('th', { scope: 'col', text: 'Status' })
        )),
        tb
      )));
  }
  function liveSection() {
    var live = DATA.live || [];
    if (!live.length) return null;
    var tb = $('tbody');
    live.forEach(function (r) {
      tb.appendChild($('tr', null,
        $('td', { class: 'num', text: 'live' }),
        $('td', null, $('div', { class: 'name' }, $('b', { text: r.name }), $('span', { text: (r.category || 'Other') + ' \u00B7 ' + ((r.chains || []).slice(0, 2).join(', ') || 'an unnamed chain') }))),
        $('td', { class: 'num', text: usd(r.tvl_usd) }),
        $('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: pct(r.change_7d) }),
        $('td', { class: 'num', text: usd(r.mcap_usd) }),
        $('td', { class: 'num', title: 'Market cap / TVL: what the market actually pays per dollar locked', text: (r.mcap_usd !== null && r.tvl_usd > 0 ? '\u00D7' + (r.mcap_usd / r.tvl_usd).toFixed(2) : 'n/a') }),
        $('td', null, $('span', { class: 'tag live', text: 'already trades' }))
      ));
    });
    return $('section', { class: 'section' },
      $('h2', { text: 'Live-token protocols \u2014 set aside, not ranked' }),
      $('p', { text: 'These ' + live.length + ' protocols already have a token that trades, so their market cap is a fact from the market, not a model. They are not part of the ranking above and carry no implied value. The mcap/TVL column shows what the market actually pays per dollar locked \u2014 the same ratio the model\u2019s comparables are built from.' }),
      $('div', { class: 'panel' }, $('div', { class: 'table-wrap' },
        $('table', null,
          $('caption', { text: 'Top ' + live.length + ' live-token protocols by market cap.' }),
          $('thead', null, $('tr', null,
            $('th', { scope: 'col', text: 'Status' }), $('th', { scope: 'col', text: 'Protocol' }), $('th', { scope: 'col', text: 'TVL' }), $('th', { scope: 'col', text: '7d' }), $('th', { scope: 'col', text: 'Market cap' }), $('th', { scope: 'col', text: 'mcap/TVL' }), $('th', { scope: 'col', text: 'Token' })
          )),
          tb
        ))));
  }
  // What the model changes vs a plain TVL sort, computed live from the board:
  // the two top-5 lists side by side, plus the biggest climber and faller.
  function vsTvlSection() {
    var byTvl = DATA.rows.slice().sort(function (a, b) { return b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1); });
    var topTvl = byTvl.slice(0, 5), topImp = DATA.rows.slice(0, 5);
    var outside = DATA.rows.slice(0, 10).filter(function (r) { return TVLRANK[r.slug] > 10; }).length;
    var moves = DATA.rows.map(function (r) { return { r: r, d: delta(r) }; }).sort(function (a, b) { return b.d - a.d; });
    var up = moves[0], down = moves[moves.length - 1];
    function mini(list, rankOf) {
      return $('ol', { class: 'mini' }, list.map(function (r) {
        return $('li', null, $('b', { text: r.name }), $('span', { class: 'muted', text: ' \u2014 ' + rankOf(r) }));
      }));
    }
    return $('div', { class: 'vs' },
      $('h3', { text: 'What the model changes vs a plain TVL sort' }),
      $('p', { class: 'muted', text: 'A TVL sort would crown the biggest protocol and stop there. The model re-ranks: ' + outside + ' of the top 10 by implied value sit outside the TVL top 10. Biggest climber ' + up.r.name + ' (+' + up.d + ' places, TVL rank ' + TVLRANK[up.r.slug] + ' \u2192 implied rank ' + up.r.rank + '); biggest faller ' + down.r.name + ' (' + down.d + ' places, TVL rank ' + TVLRANK[down.r.slug] + ' \u2192 implied rank ' + down.r.rank + ').' }),
      $('div', { class: 'vs-grid' },
        $('div', null, $('h3', { text: 'Top 5 by TVL alone' }), mini(topTvl, function (r) { return 'implied rank ' + r.rank; })),
        $('div', null, $('h3', { text: 'Top 5 by implied value' }), mini(topImp, function (r) { return 'TVL rank ' + TVLRANK[r.slug]; }))
      ));
  }
  // Where each category's multiple comes from: the comparables table, largest first.
  function compsSection() {
    var counts = M.category_comp_counts || {};
    var ratios = M.category_ratios || {};
    var entries = Object.keys(counts).map(function (c) { return { c: c, n: counts[c], ratio: ratios[c] }; })
      .sort(function (a, b) { return b.n - a.n || (a.c < b.c ? -1 : 1); });
    var tb = $('tbody');
    entries.slice(0, 8).forEach(function (e) {
      tb.appendChild($('tr', null,
        $('td', { text: e.c }),
        $('td', { class: 'num', text: typeof e.ratio === 'number' ? e.ratio.toFixed(6) : 'n/a' }),
        $('td', { class: 'num', text: String(e.n) }),
        $('td', { text: e.n > 0 ? 'category blend' : 'global median' })
      ));
    });
    return $('div', { class: 'comps' },
      $('h3', { text: 'Where each category\u2019s multiple comes from' }),
      $('p', { class: 'muted', text: 'Every multiple below is the shrinkage-blended median mcap/TVL of that category\u2019s tokenised protocols in the snapshot \u2014 ' + (M.total_comps || entries.length) + ' comparables in all, each comp ratio winsorized at the ' + Math.round(WP * 100) + 'th percentile (' + (WC === null ? 'n/a' : WC.toFixed(6)) + ') first, then blended as (n\u00D7cat + ' + SK + '\u00D7global)/(n + ' + SK + '). A category with no comps at all uses the global median ' + (typeof M.global_ratio === 'number' ? M.global_ratio.toFixed(6) : 'n/a') + '.' }),
      $('table', null, $('thead', null, $('tr', null,
        $('th', { scope: 'col', text: 'Category' }), $('th', { scope: 'col', text: 'Ratio' }), $('th', { scope: 'col', text: 'Comps' }), $('th', { scope: 'col', text: 'Source' })
      )), tb),
      $('p', { class: 'muted', text: 'Largest categories shown; ' + entries.length + ' categories carry a multiple.' })
    );
  }
  // Checked against the market: the model's ranking over the tokenised comps
  // vs the TVL-only baseline, computed at build time and stored in data.js.
  // The level error is deliberately not shown — individual mcap/TVL ratios
  // are extremely dispersed, so a median-based model ranks well while any
  // single level can be off by several times.
  function calibrationSection() {
    var cal = M.calibration || null;
    var n = cal && typeof cal.n === 'number' ? cal.n : (M.total_comps || 0);
    var sm = cal && typeof cal.spearman_model === 'number' ? cal.spearman_model : null;
    var st = cal && typeof cal.spearman_tvl === 'number' ? cal.spearman_tvl : null;
    var line = (sm === null || st === null)
      ? 'Calibration not computed for this snapshot.'
      : 'Checked against the market: on the ' + n + ' protocols whose token already trades, this model\u2019s ranking tracks their actual market caps (Spearman ' + sm.toFixed(2) + ') better than TVL alone (' + st.toFixed(2) + ').';
    return $('div', { class: 'calibration' },
      $('h3', { text: 'Checked against the market' }),
      $('p', { text: line }),
      $('p', { class: 'muted', text: '15 band\u00D7shrinkage settings tried by leave-one-out; no setting beats the chosen 10\u00D7/k=3 clearly (best 1.48 vs 1.61 median abs log error, within noise), so the width is the principled middle, not a tuned peak.' })
    );
  }
  function modelSection() {
    return $('section', { class: 'section' },
      $('div', { class: 'panel model' },
        $('h2', { text: 'How the model works' }),
        $('p', { class: 'muted', text: 'One function scores every protocol. No name is special-cased, no row is hand-picked, and the detail view recomputes each row from the snapshot figures so the page and the board agree.' }),
        $('div', { class: 'formula' },
          $('span', { html: 'implied = round( <span class="k">TVL</span> \u00D7 band ratio \u00D7 (1 + ' + GW + ' \u00D7 tanh(7d growth / ' + GTS + ')) \u00D7 (' + MF + ' + ' + MR + ' \u00D7 ln(1 + min(age, ' + MD + 'd)) / ln(1 + ' + MD + 'd)) \u00D7 chain )' })
        ),
        $('table', null, $('tbody', null,
          $('tr', null, $('td', { text: 'base = TVL \u00D7 band ratio' }), $('td', { text: 'The median mcap/TVL of the category\u2019s tokenised comparables whose TVL sits within ' + BF + '\u00D7 of this protocol\u2019s (at least ' + BM + ' of them), shrunk toward the same band\u2019s global median as (n\u00D7cat + ' + SK + '\u00D7global)/(n + ' + SK + '); every comp ratio winsorized at the ' + Math.round(WP * 100) + 'th percentile (' + (WC === null ? 'n/a' : WC.toFixed(6)) + ') first. A band too thin falls back to the category-wide blend, and a category with no comps takes the global median ' + BASE.toFixed(6) + '.' })),
          $('tr', null, $('td', { text: 'growth multiplier' }), $('td', { text: 'Seven-day TVL change through a saturating tanh: 1 + ' + GW + ' \u00D7 tanh(change / ' + GTS + '). A protocol growing +20% in a week scores \u00D7' + (1 + GW * Math.tanh(20 / GTS)).toFixed(2) + '; one shrinking \u221230% scores \u00D7' + (1 + GW * Math.tanh(-30 / GTS)).toFixed(2) + '; a wild +4448% week no more than \u00D7' + (1 + GW).toFixed(2) + '. Unreported change scores \u00D71.00.' })),
          $('tr', null, $('td', { text: 'maturity multiplier' }), $('td', { text: 'Days since first listing, capped at ' + MD + ' days (' + (MD / 365).toFixed(0) + ' years), on a log curve: ' + MF + ' at day zero rising to ' + (MF + MR).toFixed(1) + ', so the early years matter most \u2014 a 15-day protocol scores \u00D7' + (MF + MR * Math.log(16) / Math.log(1 + MD)).toFixed(2) + ', not \u00D7' + (MF + MR * 15 / MD).toFixed(2) + '. A protocol that ran for years with no token is treated as more mature \u2014 and its launch, if it comes, as more loaded. Unknown age uses ' + UA + ' days.' })),
          $('tr', null, $('td', { text: 'chain multiplier' }), $('td', { text: '1 + ' + CW + ' \u00D7 ln(chains), capped at ' + CC + ': a protocol live on more chains scores a little higher. One chain scores \u00D71.00.' })),
          $('tr', null, $('td', { text: 'what it is not' }), $('td', { text: 'Not a price, not a prediction of whether or when a token is issued, and not a floor. A protocol that records no token may still have one its DefiLlama record does not carry.' }))
        )),
        vsTvlSection(),
        compsSection(),
        calibrationSection(),
        $('p', { class: 'note', text: 'Snapshot ' + DATA.as_of + ' \u00B7 watchlist floor ' + usd(DATA.floor_usd) + ' \u00B7 model ' + (DATA.model_version || 'radar-1') + ' \u00B7 ' + DATA.rows.length + ' ranked rows.' })
      ));
  }

  var dialog = $('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.sel = null; writeHash(); render(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.sel = slug; writeHash();
    var m = mdl(row);
    // Where this row's ratio comes from: radar-3 stores it on the row itself —
    // the TVL-band median over the comps that priced it, or the category-wide
    // shrinkage blend, or the global median when the category has no comps.
    // ratio_source is 'band' | 'category' | 'global'; comps counts the comps
    // that set it. Older data.js files carry neither: fall back to the
    // category's comp count from the model table.
    var catKey = row.category || 'Uncategorized';
    var compN = (typeof row.comps === 'number') ? row.comps
      : (M.category_comp_counts && typeof M.category_comp_counts[catKey] === 'number') ? M.category_comp_counts[catKey] : null;
    var src = row.ratio_source || (compN !== null && compN > 0 ? 'category' : 'global');
    var ratioNote;
    if (src === 'band') ratioNote = (row.category || 'Other') + ' TVL-band median over ' + compN + ' comps within ' + BF + '\u00D7 TVL, shrunk toward the band global median';
    else if (src === 'category') ratioNote = (row.category || 'Other') + ' shrinkage blend over ' + compN + ' comp' + (compN === 1 ? '' : 's') + ' (band too thin, (n\u00D7cat + ' + SK + '\u00D7global)/(n + ' + SK + '))';
    else ratioNote = 'global median over ' + (M.total_comps || '?') + ' comps (' + (row.category || 'Other') + ' has no comps)';
    // Why this rank, not its TVL rank: the multiplier that moved it most.
    var drivers = [
      { label: 'growth', v: m.gm, why: '7-day TVL change ' + pct(m.raw) },
      { label: 'maturity', v: m.mm, why: (m.ageKnown ? age(row.age_days) : 'unknown age') + ' on the books' },
      { label: 'chain', v: m.cm, why: (row.chains || []).length + ' chain' + ((row.chains || []).length === 1 ? '' : 's') }
    ];
    drivers.sort(function (a, b) { return Math.abs(b.v - 1) - Math.abs(a.v - 1); });
    var top = drivers[0];
    var whyRank = 'TVL rank ' + TVLRANK[row.slug] + ' \u2192 implied rank ' + row.rank + ' (' + (delta(row) > 0 ? '+' : '') + delta(row) + ' places): the largest single effect is ' + top.label + ' \u00D7' + top.v.toFixed(4) + ' (' + top.why + ').';
    dialog.textContent = '';
    dialog.appendChild($('div', { class: 'd-head' },
      $('div', null,
        $('span', { class: 'brand-name', text: 'RANK ' + row.rank + ' OF ' + DATA.rows.length }),
        $('h2', { id: 'detail-title', text: row.name }),
        $('p', { class: 'sub', text: (row.category || 'Other') + ' \u00B7 ' + ((row.chains || []).join(', ') || 'an unnamed chain') + (WATCH.has(row.slug) ? ' \u00B7 watchlist' : '') })
      ),
      $('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild($('section', { class: 'd-sec' },
      $('h3', { text: 'Snapshot record' }),
      $('div', { class: 'kv' },
        $('div', null, $('span', { text: 'TVL' }), $('b', { text: usd(row.tvl_usd) })),
        $('div', null, $('span', { text: '7-day change' }), $('b', { class: row.change_7d !== null && row.change_7d >= 0 ? 'pos' : 'neg', text: pct(row.change_7d) })),
        $('div', null, $('span', { text: 'Age' }), $('b', { text: age(row.age_days) })),
        $('div', null, $('span', { text: 'First listed' }), $('b', { text: row.listed_at || 'unknown' })),
        $('div', null, $('span', { text: 'Market cap' }), $('b', { text: row.mcap_usd === null || row.mcap_usd === undefined ? 'none recorded' : usd(row.mcap_usd) })),
        $('div', null, $('span', { text: 'Token status' }), $('b', { text: isPre(row) ? 'records no token' : 'token trades' }))
      ),
      $('p', { class: 'note', text: isPre(row) ? 'The snapshot records no token for this protocol. That is the record, not proof: a token may exist that the record does not carry.' : 'This protocol records a token, so it is shown for reference and is not part of the pre-token ranking.' })
    ));
    dialog.appendChild($('section', { class: 'd-sec' },
      $('h3', { text: 'Implied value, step by step' }),
      $('div', { class: 'math' },
        $('div', { class: 'row' }, $('span', { text: '1 \u00B7 base = TVL \u00D7 ' + m.ratio.toFixed(6) + ' (' + ratioNote + ')' }), $('b', { text: usdFull(m.base) })),
        $('div', { class: 'row' }, $('span', { text: '2 \u00B7 growth ' + (m.changeKnown ? pct(m.raw) + ' \u2192 1 + ' + GW + '\u00D7tanh(' + m.raw.toFixed(2) + '/' + GTS + ') \u2192 \u00D7' + m.gm.toFixed(4) : 'not reported \u2192 \u00D7' + m.gm.toFixed(4)) }), $('b', { text: '\u00D7' + m.gm.toFixed(4) })),
        $('div', { class: 'row' }, $('span', { text: '3 \u00B7 maturity ' + (m.ageKnown ? age(row.age_days) + ' (' + m.ageUsed + 'd, log curve)' : 'unknown \u2192 ' + UA + 'd assumed') + ' \u2192 \u00D7' + m.mm.toFixed(4) }), $('b', { text: '\u00D7' + m.mm.toFixed(4) })),
        $('div', { class: 'row' }, $('span', { text: '4 \u00B7 chains ' + (row.chains || []).length + ' \u2192 \u00D7' + m.cm.toFixed(4) }), $('b', { text: '\u00D7' + m.cm.toFixed(4) })),
        $('div', { class: 'row' }, $('span', { text: '5 \u00B7 ' + usdFull(m.base) + ' \u00D7 ' + m.gm.toFixed(4) + ' \u00D7 ' + m.mm.toFixed(4) + ' \u00D7 ' + m.cm.toFixed(4) }), $('b', { text: usdFull(m.implied) })),
        $('div', { class: 'row total' }, $('span', { text: 'Implied value (board: ' + usdFull(row.implied_value_usd) + ')' }), $('b', { text: usdFull(row.implied_value_usd) }))
      ),
      $('p', { class: 'why', text: whyRank }),
      $('p', { class: 'muted', text: (function () {
        var d = m.implied - row.implied_value_usd;
        if (d === 0) return 'The page recomputes this row as ' + usdFull(m.implied) + ' \u2014 the same number the board carries.';
        // The board rounds the base to whole dollars and lowers tied values by
        // $1 so the ranking stays strict: a few dollars apart is the same row,
        // not stale data.
        if (Math.abs(d) <= 10) return 'The page recomputes this row as ' + usdFull(m.implied) + ', within a few dollars of the board\u2019s ' + usdFull(row.implied_value_usd) + ': the board rounds the base to whole dollars and lowers tied values by $1 so the ranking stays strict.';
        return 'The page recomputes this row as ' + usdFull(m.implied) + ', which differs from the board\u2019s ' + usdFull(row.implied_value_usd) + ': the data would be stale.';
      })() })
    ));
    dialog.appendChild($('section', { class: 'd-sec' },
      $('h3', { text: 'Farm plan' }),
      $('ol', { class: 'steps' }, stepsOf(row).map(function (s) {
        var p = splitStep(s);
        return $('li', null, $('b', { text: p.act }), p.tail ? $('span', { class: 'cost', text: p.tail }) : null);
      }))
    ));
    dialog.appendChild($('section', { class: 'd-sec' },
      $('p', { class: 'muted', text: 'Snapshot ' + DATA.as_of + ' \u00B7 watchlist floor ' + usd(DATA.floor_usd) + ' \u00B7 model ' + (DATA.model_version || 'radar-1') + '. Implied value is a model, not a price.' })
    ));
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute('open', '');
  }

  function render() {
    app.textContent = '';
    var sh = $('div', { class: 'shell' });
    sh.appendChild(head());
    sh.appendChild(lede());
    sh.appendChild(controls());
    sh.appendChild(boardTable());
    var live = liveSection(); if (live) sh.appendChild(live);
    sh.appendChild(modelSection());
    sh.appendChild($('footer', { class: 'foot', text: 'TOKEN RADAR \u00B7 snapshot ' + DATA.as_of + ' \u00B7 model ' + (DATA.model_version || 'radar-1') + ' \u00B7 data from data.js, no network \u00B7 implied value is a model, not a price.' }));
    app.appendChild(sh);
    if (!dialog.isConnected) app.appendChild(dialog);
    app.setAttribute('aria-busy', 'false');
    if (state.sel) openDetail(state.sel);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && dialog.open) dialog.close(); });
})();
