/* gk-labs archive. reads catalog.json, then each project's manifest.json on demand.
   routes live in the hash: #/<project>/<version>/<path to file> */
(function () {
  'use strict';

  var root = document.documentElement;
  var app = document.getElementById('app');
  var state = { catalog: null, manifests: {}, searchIndex: null };

  /* ---------- small helpers ---------- */

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (attrs[k] == null || attrs[k] === false) continue;
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    (kids || []).forEach(function (c) {
      if (c == null || c === false) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }
  function split(tag, text, cls) {
    return el(tag, { class: 'ca ' + (cls || ''), 'data-text': text, text: text });
  }
  function num(n) { return Number(n || 0).toLocaleString('en-US'); }
  function bytes(b) {
    if (b < 1024) return b + ' b';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' kb';
    return (b / 1048576).toFixed(1) + ' mb';
  }
  function plural(n, one, many) { return num(n) + ' ' + (n === 1 ? one : many); }
  function enc(path) { return path.split('/').map(encodeURIComponent).join('/'); }
  function store(key, val) {
    try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch (e) { return null; }
  }
  function getJSON(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(r.status === 404 ? 'not found' : 'http ' + r.status);
      return r.json();
    });
  }
  function project(name) {
    return state.catalog.projects.filter(function (p) { return p.name === name; })[0];
  }
  function manifest(p) {
    if (!state.manifests[p.name]) {
      state.manifests[p.name] = getJSON(p.path + '/manifest.json').catch(function (e) {
        delete state.manifests[p.name];
        throw e;
      });
    }
    return state.manifests[p.name];
  }

  /* ---------- controls: theme + split ---------- */

  function setTheme(t) {
    root.setAttribute('data-theme', t);
    store('gk-theme', t);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', t === 'print' ? '#f4f1ea' : t === 'thermal' ? '#0e0a09' : '#0b0b0d');
  }
  document.querySelectorAll('input[name="theme"]').forEach(function (r) {
    r.checked = r.value === root.getAttribute('data-theme');
    r.addEventListener('change', function () { if (r.checked) setTheme(r.value); });
  });
  var splitInput = document.getElementById('split');
  if (splitInput) {
    splitInput.value = getComputedStyle(root).getPropertyValue('--disp').trim() || '1';
    splitInput.addEventListener('input', function () {
      root.style.setProperty('--disp', splitInput.value);
      store('gk-split', splitInput.value);
    });
  }

  /* the cursor is the light source, fringes point away from it */
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)');
  var raf = 0;
  window.addEventListener('pointermove', function (e) {
    if ((reduce && reduce.matches) || raf) return;
    raf = requestAnimationFrame(function () {
      raf = 0;
      var x = (e.clientX / innerWidth - 0.5) * -2, y = (e.clientY / innerHeight - 0.5) * -2;
      var len = Math.hypot(x, y) || 1;
      root.style.setProperty('--ca-x', (x / len).toFixed(3));
      root.style.setProperty('--ca-y', (y / len * 0.6).toFixed(3));
    });
  }, { passive: true });

  /* ---------- the front desk + stacks ---------- */

  function renderHome() {
    var c = state.catalog, t = c.totals;
    document.title = 'gk-labs archive';
    var input = el('input', {
      id: 'find', type: 'search', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'a project, a file, a branch', 'aria-controls': 'results'
    });
    var results = el('div', { id: 'results', class: 'results', hidden: true, 'aria-live': 'polite' });
    input.addEventListener('input', debounce(function () { search(input.value, results); }, 120));

    var desk = el('section', { class: 'desk', 'aria-labelledby': 'desk-title' }, [
      el('p', { class: 'desk-eyebrow', text: 'gk-labs · the stacks' }),
      el('h1', { id: 'desk-title' }, [split('span', 'the archive')]),
      el('p', { class: 'lede', text: "every version of everything i've made, slapped in one place. each project gets a shelf in its sector, and every branch it ever had is filed next to it as its own copy." }),
      el('p', { class: 'tally' }, [
        el('b', { text: plural(t.projects, 'project', 'projects') }), ' across ', el('b', { text: plural(c.sectors.length, 'sector', 'sectors') }),
        ', ', el('b', { text: plural(t.versions, 'version', 'versions') }), ', ',
        el('b', { text: plural(t.files, 'file', 'files') }), ' (' + bytes(t.bytes) + ').'
      ]),
      el('div', { class: 'finder', role: 'search' }, [
        el('label', { for: 'find', text: 'find anything in the stacks' }),
        el('div', { class: 'finder-box' }, [input, el('kbd', { 'aria-hidden': 'true', text: '/' })]),
        results
      ])
    ]);

    var stacks = el('div', { class: 'stacks' }, c.sectors.map(function (s) {
      var items = c.projects.filter(function (p) { return p.sector === s.id; });
      return el('section', { class: 'sector', id: 'sector-' + s.id, 'aria-labelledby': 'sh-' + s.id }, [
        el('header', { class: 'sector-head' }, [
          split('span', s.letter, 'sector-letter'),
          el('h2', { class: 'sector-name', id: 'sh-' + s.id }, [s.title, el('small', { text: 'sector ' + s.letter })]),
          el('p', { class: 'sector-blurb', text: s.blurb })
        ]),
        items.length
          ? el('ol', { class: 'shelf' }, items.map(entry))
          : el('p', { class: 'empty-shelf', text: 'this shelf is empty for now. nothing filed here yet.' })
      ]);
    }));

    swap([desk, stacks]);
  }

  function entry(p) {
    var href = '#/' + enc(p.name);
    return el('li', { class: 'entry' }, [
      el('span', { class: 'acc', text: 'acc. ' + p.accession }),
      el('h3', {}, [
        el('a', { class: 'entry-title ca', href: href, 'data-text': p.title, text: p.title }),
        p.kind === 'demo' ? el('span', { class: 'stamp', text: 'demo installed' }) : null
      ]),
      el('p', { class: 'entry-summary', text: p.summary }),
      el('p', { class: 'entry-meta' }, [
        plural(p.versions, 'version', 'versions'), el('span', { class: 'dot', text: '·' }),
        plural(p.files, 'file', 'files'), el('span', { class: 'dot', text: '·' }),
        span(p.first, p.last)
      ]),
      el('div', { class: 'entry-actions' }, [
        p.kind === 'demo' ? el('a', { class: 'btn solid', href: p.path + '/' + p.entry, text: 'run the demo' }) : null,
        el('a', { class: 'btn', href: href, text: p.kind === 'demo' ? 'read the files' : 'open the shelf' })
      ])
    ]);
  }
  function span(a, b) { return !a ? 'undated' : a === b ? 'filed ' + a : a + ' to ' + b; }

  /* ---------- search across every project, version and file ---------- */

  function buildIndex() {
    if (state.searchIndex) return state.searchIndex;
    state.searchIndex = Promise.all(state.catalog.projects.map(function (p) {
      return manifest(p).then(function (m) {
        var rows = [];
        m.versions.forEach(function (v) {
          if (v.same_as) return;
          v.files.forEach(function (f) { rows.push({ p: p, v: v.id, branch: v.branch, path: f[0] }); });
        });
        return rows;
      }).catch(function () { return []; });
    })).then(function (all) { return [].concat.apply([], all); });
    return state.searchIndex;
  }

  function search(q, box) {
    q = q.trim().toLowerCase();
    box.textContent = '';
    if (!q) { box.hidden = true; return; }
    box.hidden = false;
    box.setAttribute('aria-busy', 'true');
    box.appendChild(skeleton(3));
    buildIndex().then(function (rows) {
      box.removeAttribute('aria-busy');
      box.textContent = '';
      var projects = state.catalog.projects.filter(function (p) {
        return (p.title + ' ' + p.name + ' ' + p.summary).toLowerCase().indexOf(q) > -1;
      });
      var files = rows.filter(function (r) {
        return r.path.toLowerCase().indexOf(q) > -1 || r.branch.toLowerCase().indexOf(q) > -1;
      });
      var total = projects.length + files.length;
      if (!total) {
        box.appendChild(el('p', { class: 'results-head', text: 'nothing in the stacks matches "' + q + '".' }));
        return;
      }
      box.appendChild(el('p', { class: 'results-head', text: plural(total, 'match', 'matches') + (files.length > 40 ? ', showing the first 40 files' : '') }));
      projects.forEach(function (p) {
        box.appendChild(el('a', { class: 'hit', href: '#/' + enc(p.name) }, [
          el('span', { class: 'hit-path' }, [mark(p.title, q)]),
          el('span', { class: 'hit-where', text: 'shelf · acc. ' + p.accession })
        ]));
      });
      files.slice(0, 40).forEach(function (r) {
        box.appendChild(el('a', { class: 'hit', href: '#/' + enc(r.p.name) + '/' + enc(r.v) + '/' + enc(r.path) }, [
          el('span', { class: 'hit-path mono' }, [mark(r.path, q)]),
          el('span', { class: 'hit-where', text: r.p.title + ' · ' + r.branch })
        ]));
      });
    });
  }
  function mark(text, q) {
    var i = text.toLowerCase().indexOf(q);
    if (i < 0) return document.createTextNode(text);
    var f = document.createDocumentFragment();
    f.appendChild(document.createTextNode(text.slice(0, i)));
    f.appendChild(el('mark', { text: text.slice(i, i + q.length) }));
    f.appendChild(document.createTextNode(text.slice(i + q.length)));
    return f;
  }
  function debounce(fn, ms) {
    var t;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  /* ---------- a project, opened ---------- */

  function renderProject(name, versionId, filePath) {
    var p = project(name);
    if (!p) return renderMissing('there is no shelf called "' + name + '" in the archive.');
    var sector = state.catalog.sectors.filter(function (s) { return s.id === p.sector; })[0] || { title: p.sector, letter: '?' };
    document.title = p.title + ' · gk-labs archive';

    var crumbs = el('nav', { class: 'crumbs', 'aria-label': 'where you are' }, [
      el('a', { href: '#/', text: 'the archive' }), el('span', { class: 'dot', text: '/' }),
      el('a', { href: '#sector-' + p.sector, 'data-sector': p.sector, text: 'sector ' + sector.letter + ', ' + sector.title }),
      el('span', { class: 'dot', text: '/' }), el('span', { text: p.title })
    ]);
    var folio = el('header', { class: 'folio' }, [
      el('p', { class: 'folio-acc', text: 'acc. ' + p.accession + ' · ' + (p.kind === 'demo' ? 'demo installed' : 'full source') }),
      el('h1', {}, [split('span', p.title)]),
      el('p', { class: 'folio-summary', text: p.summary }),
      el('dl', { class: 'folio-facts' }, [
        fact('first touched', p.first || 'unknown'),
        fact('last touched', p.last || 'unknown'),
        fact('commits', num(p.commits)),
        fact('versions', num(p.versions)),
        fact('on the shelf', plural(p.files, 'file', 'files') + ', ' + bytes(p.bytes))
      ]),
      el('div', { class: 'folio-actions' }, [
        p.kind === 'demo' ? el('a', { class: 'btn solid', href: p.path + '/' + p.entry, text: 'run the demo' }) : null,
        el('a', { class: 'btn', href: p.path + '/history.txt', text: 'full commit history' }),
        p.source ? el('a', { class: 'btn', href: p.source, rel: 'noopener', text: 'where it came from' }) : null
      ])
    ]);
    var strata = el('section', { class: 'strata', 'aria-labelledby': 'strata-title' }, [
      el('div', { class: 'strata-head' }, [el('h2', { id: 'strata-title', text: 'versions' })]),
      skeleton(1)
    ]);
    var reading = el('section', { class: 'reading', 'aria-label': 'files' });
    swap([crumbs, folio, strata, reading]);

    manifest(p).then(function (m) {
      var filed = m.versions.filter(function (v) { return !v.same_as; });
      var v = m.versions.filter(function (x) { return x.id === versionId; })[0] || filed[0];
      if (v && v.same_as) v = m.versions.filter(function (x) { return x.id === v.same_as; })[0];
      var sel = m.versions.filter(function (x) { return x.id === versionId; })[0] || v;
      strata.replaceChild(versionList(p, m, v && sel.id), strata.lastChild);
      if (!v) { reading.appendChild(el('p', { class: 'note', text: 'no versions filed yet.' })); return; }
      var note = el('p', { class: 'stratum-note' });
      note.textContent = 'branch ' + sel.branch + ', last commit ' + sel.head + ' on ' + sel.date + ': "' + sel.message + '"' +
        (sel.same_as ? '. same files as ' + sel.same_as + ', so it shares that copy.' : '');
      strata.appendChild(note);
      renderReading(reading, p, v, filePath || pickStart(v));
    }, function (e) {
      strata.replaceChild(failure('couldn\'t open this shelf\'s manifest (' + e.message + ').', function () { renderProject(name, versionId, filePath); }), strata.lastChild);
    });
  }
  function fact(k, v) { return el('div', {}, [el('dt', { text: k }), el('dd', { text: v })]); }

  function versionList(p, m, selected) {
    return el('div', { class: 'strata-list', role: 'group', 'aria-label': 'pick a version' }, m.versions.map(function (v) {
      var on = v.id === selected;
      return el('button', {
        class: 'stratum', type: 'button', 'aria-pressed': on ? 'true' : 'false',
        onclick: function () { go('#/' + enc(p.name) + '/' + enc(v.id)); }
      }, [v.branch, v.same_as ? el('span', { class: 'same', text: '= ' + v.same_as }) : null]);
    }));
  }

  function pickStart(v) {
    var names = v.files.map(function (f) { return f[0]; });
    var picks = ['README.md', 'readme.md', 'README', 'index.html'];
    for (var i = 0; i < picks.length; i++) if (names.indexOf(picks[i]) > -1) return picks[i];
    return names[0];
  }

  /* ---------- the reading room ---------- */

  function renderReading(box, p, v, path) {
    box.textContent = '';
    var filter = el('input', { class: 'drawer-filter', type: 'search', placeholder: 'filter ' + plural(v.files.length, 'file', 'files'), 'aria-label': 'filter files' });
    var tree = el('div', { class: 'tree' });
    var drawer = el('nav', { class: 'drawer', 'aria-label': 'files in ' + v.branch }, [filter, tree]);
    var page = el('article', { class: 'page', 'aria-live': 'polite' });
    box.appendChild(drawer);
    box.appendChild(page);

    function draw(q) {
      tree.textContent = '';
      var files = q ? v.files.filter(function (f) { return f[0].toLowerCase().indexOf(q) > -1; }) : v.files;
      if (!files.length) { tree.appendChild(el('p', { class: 'muted', text: 'no file matches.' })); return; }
      tree.appendChild(buildTree(files, p, v, path, !!q));
    }
    filter.addEventListener('input', debounce(function () { draw(filter.value.trim().toLowerCase()); }, 100));
    draw('');
    var current = tree.querySelector('[aria-current="true"]');
    if (current && current.scrollIntoView && drawer.scrollHeight > drawer.clientHeight) current.scrollIntoView({ block: 'nearest' });
    if (path) readFile(page, p, v, path);
  }

  function buildTree(files, p, v, current, openAll) {
    var rootNode = { dirs: {}, files: [] };
    files.forEach(function (f) {
      var parts = f[0].split('/'), node = rootNode;
      for (var i = 0; i < parts.length - 1; i++) node = node.dirs[parts[i]] = node.dirs[parts[i]] || { dirs: {}, files: [] };
      node.files.push(f);
    });
    var curDir = current ? current.split('/').slice(0, -1).join('/') : '';
    function list(node, prefix) {
      var ul = el('ul');
      Object.keys(node.dirs).sort().forEach(function (d) {
        var full = prefix + d;
        var open = openAll || curDir === full || curDir.indexOf(full + '/') === 0;
        ul.appendChild(el('li', {}, [el('details', { open: open }, [el('summary', { text: d + '/' }), list(node.dirs[d], full + '/')])]));
      });
      node.files.sort(function (a, b) { return a[0] < b[0] ? -1 : 1; }).forEach(function (f) {
        ul.appendChild(el('li', {}, [el('a', {
          href: '#/' + enc(p.name) + '/' + enc(v.id) + '/' + enc(f[0]),
          'aria-current': f[0] === current ? 'true' : null,
          title: bytes(f[1]),
          text: f[0].split('/').pop()
        })]));
      });
      return ul;
    }
    var top = list(rootNode, '');
    top.style.borderLeft = '0';
    top.style.paddingLeft = '0';
    top.style.marginLeft = '0';
    return top;
  }

  var IMG = /\.(png|jpe?g|gif|webp|svg|ico|avif|bmp)$/i;
  var BIN = /\.(woff2?|ttf|otf|eot|zip|gz|tgz|7z|rar|exe|dll|msi|bin|pdf|mp3|mp4|webm|mov|wav|ogg|icns|dmg|node|wasm|jar|class|o|a|so|pyc|db|sqlite)$/i;
  var MAX_TEXT = 1.5 * 1048576;

  function readFile(page, p, v, path) {
    var f = v.files.filter(function (x) { return x[0] === path; })[0];
    page.textContent = '';
    if (!f) { page.appendChild(el('p', { class: 'note err', text: 'this version has no file at ' + path + '.' })); return; }
    var url = p.path + '/' + enc(v.id) + '/' + enc(path);
    var status = el('span', { class: 'page-status', role: 'status' });
    var tools = el('div', { class: 'page-tools' }, [status, el('a', { class: 'btn small', href: url, download: path.split('/').pop(), text: 'download' }), el('a', { class: 'btn small', href: url, text: 'raw' })]);
    var head = el('header', { class: 'page-head' }, [el('p', { class: 'page-path mono', text: path + '  ·  ' + bytes(f[1]) }), tools]);
    var body = el('div', { class: 'page-body' }, [skeleton(8)]);
    page.appendChild(head);
    page.appendChild(body);

    if (IMG.test(path)) {
      body.textContent = '';
      body.appendChild(el('img', { src: url, alt: path, loading: 'lazy' }));
      return;
    }
    if (BIN.test(path)) { body.textContent = ''; body.appendChild(el('p', { class: 'note', text: 'this one is binary, so there\'s nothing to read here. download it instead.' })); return; }
    if (f[1] > MAX_TEXT) { body.textContent = ''; body.appendChild(el('p', { class: 'note', text: 'this file is ' + bytes(f[1]) + ', too big to read in the page. open it raw or download it.' })); return; }

    fetch(url).then(function (r) {
      if (!r.ok) throw new Error(r.status === 404 ? 'it isn\'t on the server' : 'http ' + r.status);
      return r.arrayBuffer();
    }).then(function (buf) {
      var bytesView = new Uint8Array(buf.slice(0, 8000));
      for (var i = 0; i < bytesView.length; i++) if (bytesView[i] === 0) throw { binary: true };
      var text = new TextDecoder('utf-8').decode(buf);
      body.textContent = '';
      var pre = el('pre', { class: 'code', tabindex: '0', 'aria-label': path });
      var lines = text.replace(/\r\n?/g, '\n').split('\n');
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      var frag = document.createDocumentFragment();
      lines.forEach(function (line) { frag.appendChild(el('span', { class: 'l', text: line || ' ' })); });
      pre.appendChild(frag);
      body.appendChild(pre);
      tools.insertBefore(copyButton(text, pre, status), tools.children[1]);
    }).catch(function (e) {
      body.textContent = '';
      if (e && e.binary) body.appendChild(el('p', { class: 'note', text: 'this one is binary, so there\'s nothing to read here. download it instead.' }));
      else body.appendChild(failure('couldn\'t read this file (' + (e.message || 'network') + ').', function () { readFile(page, p, v, path); }));
    });
  }

  function copyButton(text, pre, status) {
    return el('button', {
      class: 'btn small', type: 'button', text: 'copy',
      onclick: function () {
        var done = function () { status.textContent = 'copied'; setTimeout(function () { status.textContent = ''; }, 2000); };
        var fail = function () {
          var range = document.createRange();
          range.selectNodeContents(pre);
          var s = getSelection(); s.removeAllRanges(); s.addRange(range);
          status.textContent = 'couldn\'t copy, it\'s selected for you';
        };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail);
        else fail();
      }
    });
  }

  /* ---------- states ---------- */

  function skeleton(n) {
    var s = el('div', { class: 'skel', 'aria-hidden': 'true' });
    for (var i = 0; i < n; i++) s.appendChild(el('i'));
    return s;
  }
  function failure(msg, retry) {
    return el('div', { class: 'note err', role: 'alert' }, [
      el('p', { text: msg }),
      retry ? el('p', {}, [el('button', { class: 'btn small', type: 'button', onclick: retry, text: 'try again', style: 'margin-top:12px' })]) : null
    ]);
  }
  function renderMissing(msg) {
    swap([el('section', { class: 'desk' }, [
      el('p', { class: 'desk-eyebrow', text: 'misfiled' }),
      el('h1', {}, [split('span', 'not here')]),
      el('p', { class: 'lede', text: msg }),
      el('p', { style: 'margin-top:24px' }, [el('a', { class: 'btn', href: '#/', text: 'back to the stacks' })])
    ])]);
  }
  function swap(nodes) {
    app.textContent = '';
    app.removeAttribute('aria-busy');
    var wrap = el('div', { class: 'wrap' }, nodes);
    app.appendChild(wrap);
  }

  /* ---------- routing ---------- */

  var lastProject = null;
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
  function route() {
    var h = location.hash.replace(/^#\/?/, '');
    if (!h || h.indexOf('sector-') === 0) {
      var keep = lastProject === null && app.querySelector('.stacks');
      if (!keep) renderHome();
      lastProject = null;
      if (h) { var t = document.getElementById(h); if (t) t.scrollIntoView(); }
      else if (!keep) scrollTo(0, 0);
      return;
    }
    var parts = h.split('/').map(function (x) { try { return decodeURIComponent(x); } catch (e) { return x; } });
    var name = parts[0], version = parts[1], file = parts.slice(2).join('/');
    var sameShelf = lastProject === name + '/' + (version || '');
    var reading = app.querySelector('.reading');
    if (sameShelf && file && reading && reading.querySelector('.page')) {
      /* same version, new file: only the page changes */
      var p = project(name);
      manifest(p).then(function (m) {
        var v = m.versions.filter(function (x) { return x.id === version; })[0];
        if (v && v.same_as) v = m.versions.filter(function (x) { return x.id === v.same_as; })[0];
        if (!v) return renderProject(name, version, file);
        reading.querySelectorAll('.tree a').forEach(function (a) {
          a.setAttribute('aria-current', a.getAttribute('href') === location.hash ? 'true' : 'false');
        });
        readFile(reading.querySelector('.page'), p, v, file);
        if (innerWidth <= 860) reading.querySelector('.page').scrollIntoView({ block: 'start' });
      });
      return;
    }
    lastProject = name + '/' + (version || '');
    renderProject(name, version, file);
    scrollTo(0, 0);
  }

  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[data-sector]');
    if (!a) return;
    e.preventDefault();
    lastProject = 'x';
    location.hash = '#/';
    requestAnimationFrame(function () {
      var t = document.getElementById('sector-' + a.getAttribute('data-sector'));
      if (t) t.scrollIntoView();
    });
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== '/' || /input|textarea|select/i.test(document.activeElement.tagName)) return;
    var f = document.getElementById('find');
    if (f) { e.preventDefault(); f.focus(); }
  });

  /* ---------- start ---------- */

  function start() {
    app.setAttribute('aria-busy', 'true');
    getJSON('catalog.json').then(function (c) {
      state.catalog = c;
      window.addEventListener('hashchange', route);
      route();
    }, function (e) {
      app.textContent = '';
      app.removeAttribute('aria-busy');
      app.appendChild(el('div', { class: 'wrap' }, [el('section', { class: 'desk' }, [
        el('p', { class: 'desk-eyebrow', text: 'the archive is closed' }),
        el('h1', {}, [split('span', 'no catalog')]),
        el('p', { class: 'lede', text: location.protocol === 'file:'
          ? 'browsers won\'t let a page read files straight off your disk. run python3 tools/catalog.py, then python3 -m http.server, and open localhost:8000.'
          : 'catalog.json didn\'t load (' + e.message + '). it gets built when main is published; locally, run python3 tools/catalog.py.' }),
        el('p', { style: 'margin-top:24px' }, [el('button', { class: 'btn', type: 'button', onclick: start, text: 'try again' })])
      ])]));
    });
  }
  start();
})();
