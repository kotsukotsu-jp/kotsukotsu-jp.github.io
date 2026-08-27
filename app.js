/* こつこつ配当 フロントエンド。

   判定ロジックは Python 側（src/screener.py）と**同じ規則**をここにも実装している。
   しきい値をその場で変えて再判定するために必要な二重実装であり、
   E2Eテストで「既定しきい値におけるJS判定 = Python判定」を全銘柄で突合している。
   片方だけを直すと表示が嘘になるため、変更時は必ず両方を直すこと。 */
(function () {
  "use strict";
  var esc = window.Chart.esc, fmt = window.Chart.fmt;

  var DEFAULTS = {
    yield_min: 3.75, pbr_min: 0.5, pbr_max: 1.5,
    retained_years_min: 10, netcash_years_min: 3,
    operating_margin_min: 10, equity_ratio_min: 50,
    current_ratio_min: 200, cash_ratio_min: 20, margin_window: 1
  };
  var PROVISIONAL = { retained_years_min: 1, netcash_years_min: 1, cash_ratio_min: 1 };

  var LABELS = {
    1: "配当利回り（税引前）が3.75%以上",
    2: "PBRが0.5〜1.5倍に収まっている",
    3: "配当方針が明確で、配当実績に納得できる",
    4: "配当を払い続ける余力がある",
    5: "売上高が長期的に伸びている",
    6: "売上高営業利益率が10%以上",
    7: "EPS・BPSがともに長期的に伸びている",
    8: "自己資本比率が50%以上",
    9: "流動比率が200%以上",
    10: "総資産に占める現金等の比率が高く、伸びている"
  };
  /* チップなど幅の狭い場所で使う短縮名。正式な文言は LABELS のまま。 */
  var SHORT = {
    1: "配当利回り", 2: "PBR", 3: "配当方針", 4: "配当継続力", 5: "売上トレンド",
    6: "営業利益率", 7: "EPS・BPS", 8: "自己資本比率", 9: "流動比率", 10: "現金比率"
  };
  var VERDICT_LABEL = {
    candidate: "◎ 候補", near: "△ 惜しい", out: "× 対象外",
    excluded: "⃠ 判定対象外", insufficient: "— データ不足"
  };
  var MIN_YEARS = 5;

  /* th は判定に使うしきい値。minDsc は「表示上の絞り込み」で判定には影響しない。
     項目3は機械判定しないという前提を崩さないよう、意図的に別の入れ物にしている。 */
  /* panel は判定基準パネルの開閉。**既定は閉じる。**
     ほとんどの利用者は既定の基準を見に来るため、9本のスライダーを最初から
     出すと（特にスマートフォンでは一覧より上に積まれるため）本題が下へ流れる。
     基準を変えたい人だけがボタンで開く。 */
  var state = { data: null, th: Object.assign({}, DEFAULTS), tab: "candidate",
                sort: "y", desc: true, q: "", page: 1, per: 100, minDsc: null,
                nearFail: null, panel: false };
  var judged = [];

  /* ---------- 判定（Python の screener.py と同じ規則） ---------- */
  function ge(v, t) { return v === null || v === undefined ? "unjudged" : (v >= t ? "pass" : "fail"); }

  function judge(s, th) {
    var r = {};
    var y = (s.d !== null && s.d !== undefined && s.p) ? s.d / s.p * 100 : null;
    r[1] = { st: ge(y, th.yield_min), v: y, th: th.yield_min };

    var pbr = (s.p !== null && s.bps !== null && s.bps > 0) ? s.p / s.bps : null;
    r[2] = pbr === null ? { st: "unjudged", v: null }
      : { st: (pbr >= th.pbr_min && pbr <= th.pbr_max) ? "pass" : "fail", v: pbr };

    r[3] = { st: "unjudged", v: null };   /* 機械判定できない。合否に数えない */

    var sr = ge(s.ry, th.retained_years_min), sn = ge(s.nc, th.netcash_years_min);
    var st4;
    if (sr === "unjudged" && sn === "unjudged") st4 = "unjudged";
    else if (sr === "fail" || sn === "fail") st4 = "fail";
    else st4 = "pass";
    r[4] = { st: st4, v: null, d: { ry: s.ry, nc: s.nc } };

    r[5] = s.ss === null || s.ss === undefined ? { st: "unjudged", v: null }
      : { st: s.ss > 0 ? "pass" : "fail", v: s.ss };

    if (s.fin) r[6] = { st: "na", v: null };
    else {
      var m = th.margin_window === 3 ? s.or3 : (th.margin_window === 10 ? s.or10 : s.or);
      r[6] = { st: ge(m, th.operating_margin_min), v: m, th: th.operating_margin_min };
    }

    r[7] = (s.es === null || s.es === undefined || s.bs === null || s.bs === undefined)
      ? { st: "unjudged", v: null, d: { es: s.es, bs: s.bs } }
      : { st: (s.es > 0 && s.bs > 0) ? "pass" : "fail", v: null, d: { es: s.es, bs: s.bs } };

    r[8] = { st: ge(s.eq, th.equity_ratio_min), v: s.eq, th: th.equity_ratio_min };

    r[9] = s.fin ? { st: "na", v: null }
      : { st: ge(s.cr, th.current_ratio_min), v: s.cr, th: th.current_ratio_min };

    var lvl = ge(s.ch, th.cash_ratio_min);
    r[10] = (lvl === "unjudged" || s.chs === null || s.chs === undefined)
      ? { st: "unjudged", v: s.ch, th: th.cash_ratio_min }
      : { st: (lvl === "pass" && s.chs >= 0) ? "pass" : "fail", v: s.ch, th: th.cash_ratio_min };
    return r;
  }

  /* 項目3以外の未判定（データ欠損）を「満たした」と扱わない。
     Python 側 screener.decide() と同じ規則にすること（E2E e19 が一致を検証する）。*/
  function decide(r, s) {
    var failed = [], na = [], undecided = [];
    for (var n in r) {
      if (r[n].st === "fail") failed.push(+n);
      if (r[n].st === "na") na.push(+n);
      if (r[n].st === "unjudged" && +n !== 3) undecided.push(+n);
    }
    failed.sort(function (a, b) { return a - b; });
    /* 金融業は落ちた項目に関わらず常に判定対象外。銀行の自己資本比率は
       中央値4.9%で、項目8（50%以上）は業態上そもそも満たしようがない。
       Python 側 screener.decide() と同じ規則にすること（E2E e19 が一致を検証する）。*/
    if (s.fin) return { v: "excluded", failed: failed, na: na };
    if ((s.nper || 0) < MIN_YEARS) return { v: "insufficient", failed: [], na: [] };
    var v;
    if (failed.length) {
      v = (failed.length === 1 && !undecided.length) ? "near" : "out";
    } else if (undecided.length) {
      v = "insufficient";
    } else {
      v = "candidate";
    }
    return { v: v, failed: failed, na: na };
  }

  function recompute() {
    judged = state.data.stocks.map(function (s) {
      var r = judge(s, state.th);
      var d = decide(r, s);
      return { s: s, r: r, v: d.v, failed: d.failed, na: d.na,
               y: (s.d && s.p) ? s.d / s.p * 100 : null,
               pbr: (s.p && s.bps > 0) ? s.p / s.bps : null };
    });
  }

  /* ---------- 表示 ---------- */
  function counts() {
    var c = { candidate: 0, near: 0, out: 0, excluded: 0, insufficient: 0 };
    judged.forEach(function (j) { c[j.v]++; });
    return c;
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var rows = judged.filter(function (j) {
      if (state.tab !== "all" && j.v !== state.tab) return false;
      /* 「惜しい」は満たさなかった項目が1つだけなので、その項目で絞り込める。
         「配当利回りだけ足りない銘柄」を1クリックで見られるようにする。 */
      if (state.tab === "near" && state.nearFail !== null &&
          j.failed[0] !== state.nearFail) return false;
      if (state.minDsc !== null) {
        /* スコアが無い銘柄（配当と利益がそろう期が足りない）は、
           絞り込みを掛けた時点で「確認できない」ため除く */
        if (j.s.dsc === null || j.s.dsc === undefined || j.s.dsc < state.minDsc) return false;
      }
      if (!q) return true;
      return j.s.c.indexOf(q) === 0 || (j.s.n || "").toLowerCase().indexOf(q) >= 0;
    });
    var key = state.sort;
    rows.sort(function (a, b) {
      var x = key === "y" ? a.y : (key === "pbr" ? a.pbr : a.s[key]);
      var z = key === "y" ? b.y : (key === "pbr" ? b.pbr : b.s[key]);
      if (x === null || x === undefined) return 1;
      if (z === null || z === undefined) return -1;
      if (typeof x === "string") return state.desc ? z.localeCompare(x) : x.localeCompare(z);
      return state.desc ? z - x : x - z;
    });
    return rows;
  }

  function num(v, d, suffix) {
    if (v === null || v === undefined) return '<td class="num">—</td>';
    return '<td class="num">' + v.toFixed(d === undefined ? 1 : d) + (suffix || "") + "</td>";
  }

  function verdictCell(j) {
    var extra = j.v === "near" && j.failed.length
      ? '<span title="' + esc(LABELS[j.failed[0]]) + '">項目' + j.failed[0] + "</span>" : "";
    return '<td><span class="v v-' + j.v + '">' + VERDICT_LABEL[j.v] + "</span> " + extra + "</td>";
  }

  function reasonOf(j) {
    if (j.v === "excluded") return "銀行・証券・保険などは財務の構造が一般の事業会社と異なるため、本サイトの10項目では判定していません。";
    if (j.v === "insufficient") return "財務データが" + (j.s.nper || 0) + "期分しかないため判定していません（5期以上が必要）。";
    if (j.v === "near") return "満たさなかった項目：" + j.failed[0] + " " + LABELS[j.failed[0]];
    return "";
  }

  function renderList() {
    var c = counts(), rows = filtered();
    var tabs = [["candidate", "◎候補"], ["near", "△惜しい"], ["excluded", "判定対象外"],
                ["insufficient", "データ不足"], ["all", "全銘柄"]];
    var tabHtml = tabs.map(function (t) {
      var n = t[0] === "all" ? judged.length : c[t[0]];
      return '<button data-tab="' + t[0] + '" aria-selected="' + (state.tab === t[0]) + '">' +
        t[1] + " " + n + "</button>";
    }).join("");

    /* 「惜しい」タブのときだけ、落ちた項目で絞り込むチップを出す。
       件数は現在のしきい値で数え直す（利用者がしきい値を変えたら追随する）。 */
    var nearChips = "";
    if (state.tab === "near") {
      var byFail = {};
      judged.forEach(function (j) {
        if (j.v !== "near" || !j.failed.length) return;
        byFail[j.failed[0]] = (byFail[j.failed[0]] || 0) + 1;
      });
      var keys = Object.keys(byFail).sort(function (a, b) { return byFail[b] - byFail[a]; });
      if (keys.length > 1) {
        var chip = function (val, label, n) {
          return '<button class="chip' + (state.nearFail === val ? " on" : "") +
            '" data-nf="' + (val === null ? "" : val) + '">' + esc(label) + " " + n + "</button>";
        };
        nearChips = '<div class="chips"><span class="chips-label">満たさなかった項目で絞り込む</span>' +
          chip(null, "すべて", judged.filter(function (j) { return j.v === "near"; }).length) +
          keys.map(function (k) {
            return chip(+k, k + " " + SHORT[k], byFail[k]);
          }).join("") + "</div>";
      }
    }

    /* 候補タブの1ページ目だけ、上位3件をカードで大きく出す。
       表だけだと読み飛ばされる（静的HTML側と同じ見せ方にそろえる）。 */
    var topCards = "";
    if (state.tab === "candidate" && state.page === 1 && !state.q) {
      var top3 = rows.slice(0, 3);
      if (top3.length >= 2) {
        topCards = '<div class="ccards">' + top3.map(function (j) {
          var s2 = j.s, href = "stock/" + s2.c + ".html";
          return '<div class="ccard"><div class="ccode">' + s2.c + "</div>" +
            '<div class="cname"><a href="' + href + '">' + esc(s2.n) + "</a></div>" +
            '<div class="cyield">' + (j.y === null ? "—" : j.y.toFixed(2)) +
            "<span>%</span></div>" +
            '<div class="clabel">配当利回り</div>' +
            '<div class="cmeta">PBR <b>' + (j.pbr === null ? "—" : j.pbr.toFixed(2)) +
            "</b>　自己資本 <b>" +
            (s2.eq === null || s2.eq === undefined ? "—" : s2.eq.toFixed(1) + "%") +
            "</b></div></div>";
        }).join("") + "</div>";
      }
    }

    var start = (state.page - 1) * state.per;
    var pageRows = rows.slice(start, start + state.per);
    var body = pageRows.map(function (j) {
      var s = j.s, reason = reasonOf(j);
      var href = "stock/" + s.c + ".html";
      var tr = '<tr data-code="' + s.c + '"><td class="l"><a href="' + href + '">' +
        s.c + '</a></td><td class="l"><a href="' + href + '">' + esc(s.n) + "</a></td>" + num(j.y, 2, "%") + num(j.pbr, 2) +
        num(s.or, 1, "%") + num(s.eq, 1, "%") + num(s.cr, 0, "%") + num(s.ch, 1, "%") +
        verdictCell(j) + "</tr>";
      if (reason && (j.v === "excluded" || j.v === "near"))
        tr += '<tr class="reason-row"><td colspan="9">└ ' + esc(reason) + "</td></tr>";
      return tr;
    }).join("");

    /* カードは表の代わりなので、**数字には必ずラベルを付ける**。
       判定バッジの右に裸の「6.24%」を置いていたため、
       何の割合なのか分からないという指摘を受けた（2026-09-06）。
       「惜しい」は落ちた項目が分からないと意味がないので、バッジの隣に出す。 */
    var cards = pageRows.map(function (j) {
      var s = j.s;
      var miss = (j.v === "near" && j.failed.length)
        ? '<span class="miss">項目' + j.failed[0] + " " + esc(SHORT[j.failed[0]]) + "</span>" : "";
      return '<div class="card" data-code="' + s.c + '"><div class="nm">' + s.c + " " + esc(s.n) +
        '</div><div class="r vr"><span class="v v-' + j.v + '">' + VERDICT_LABEL[j.v] + "</span>" +
        miss + "</div>" +
        '<div class="r"><span>配当利回り</span><span>' + (j.y === null ? "—" : j.y.toFixed(2) + "%") + "</span></div>" +
        '<div class="r"><span>営業利益率</span><span>' + (s.or === null || s.or === undefined ? "—" : s.or.toFixed(1) + "%") + "</span></div>" +
        '<div class="r"><span>自己資本比率</span><span>' + (s.eq === null || s.eq === undefined ? "—" : s.eq.toFixed(1) + "%") + "</span></div>" +
        "</div>";
    }).join("");

    var empty = "";
    if (!rows.length) {
      var base = judged.filter(function (j) {
        var r = judge(j.s, DEFAULTS); return decide(r, j.s).v === state.tab;
      }).length;
      empty = '<div class="empty">この絞り込みでは0件です。' +
        (isChanged() ? "既定の基準に戻すと " + base + " 件になります。" : "") +
        (isChanged() ? ' <button id="reset2" class="primary">既定の基準に戻す</button>' : "") + "</div>";
    }

    var pages = Math.ceil(rows.length / state.per) || 1;
    var pager = pages > 1 ? '<div class="toolbar"><button id="prev">←</button><span class="count">' +
      state.page + " / " + pages + '</span><button id="next">→</button></div>' : "";

    /* 開閉ボタンは layout の外・上に置く。1カラムになる画面幅では
       「ボタン → 開いたパネル → 一覧」の順に並び、押した場所から下へ開く。
       section の中に置くと、開いたパネルがボタンより上に現れて分かりにくい。 */
    document.getElementById("view").innerHTML = panelBar() +
      '<div class="layout' + (state.panel ? "" : " nopanel") + '">' +
      '<aside id="basis">' + panelHtml() + "</aside><section>" +
      '<div class="tabs">' + tabHtml + "</div>" + nearChips +
      '<div class="toolbar"><input type="search" id="q" placeholder="銘柄コード・社名で検索" value="' +
      esc(state.q) + '"><span class="count">' + rows.length + " 件</span>" +
      '<button id="csv">CSVダウンロード</button></div>' +
      topCards +
      (rows.length ? '<div class="tablewrap swap"><table><thead><tr>' +
        th("c", "コード", true) + th("n", "銘柄名", true) + th("y", "利回り") + th("pbr", "PBR") +
        th("or", "営業利益率") + th("eq", "自己資本比率") + th("cr", "流動比率") + th("ch", "現金比率") +
        "<th>判定</th></tr></thead><tbody>" + body + "</tbody></table></div>" +
        '<div class="cards">' + cards + "</div>" + pager
        : empty) +
      "</section></div>";
    bindList();
  }

  /* 判定基準パネルの開閉ボタン。変更中はここだけ見ても分かるようにする
     （パネルを閉じていると中の「変更中」表示が見えないため）。 */
  function panelBar() {
    var ch = changedNames();
    var label = state.panel ? "判定基準を閉じる"
      : (ch.length ? "判定基準を変更中（" + esc(ch.join("・")) + "）" : "判定基準を変える");
    return '<div class="panelbar"><button id="tgpanel" class="tgl' +
      (ch.length ? " on" : "") + '" aria-expanded="' + (state.panel ? "true" : "false") +
      '" aria-controls="basis"><span class="tgl-ic" aria-hidden="true">' +
      (state.panel ? "\u2212" : "\u2699") + "</span>" + label + "</button>" +
      '<span class="count">' +
      (ch.length ? "既定の基準ではありません。" +
        '<button id="reset3" class="linkish">既定に戻す</button>'
        : "既定の基準で表示しています") + "</span></div>";
  }

  function th(key, label, left) {
    var mark = state.sort === key ? (state.desc ? " ▼" : " ▲") : "";
    return '<th class="' + (left ? "l" : "") + '" data-sort="' + key + '">' + label + mark + "</th>";
  }

  function isChanged() {
    return Object.keys(DEFAULTS).some(function (k) { return state.th[k] !== DEFAULTS[k]; });
  }
  function changedNames() {
    var map = { yield_min: "配当利回り", pbr_min: "PBR", pbr_max: "PBR",
      retained_years_min: "配当継続力", netcash_years_min: "配当継続力",
      operating_margin_min: "営業利益率", equity_ratio_min: "自己資本比率",
      current_ratio_min: "流動比率", cash_ratio_min: "現金等比率", margin_window: "営業利益率の集計期間" };
    var s = {};
    Object.keys(DEFAULTS).forEach(function (k) { if (state.th[k] !== DEFAULTS[k]) s[map[k]] = 1; });
    return Object.keys(s);
  }

  function slider(key, label, min, max, step, unit) {
    var prov = PROVISIONAL[key]
      ? '<span class="badge-prov" title="元にした考え方に具体的な数値がないため本サイトが独自に置いた暫定値です。実データで校正予定です。">暫定</span>' : "";
    return '<div class="ctl"><label for="s_' + key + '"><span>' + label + prov +
      '</span><span class="val" id="v_' + key + '">' + state.th[key] + (unit || "") + "</span></label>" +
      '<input type="range" id="s_' + key + '" data-key="' + key + '" min="' + min +
      '" max="' + max + '" step="' + step + '" value="' + state.th[key] + '">' +
      '<div class="official">既定 ' + DEFAULTS[key] + (unit || "") + "</div></div>";
  }

  function panelHtml() {
    var ch = changedNames();
    return '<div class="panel"><h2>判定基準</h2>' +
      '<div class="changed' + (ch.length ? " on" : "") + '" id="changed">⚠ 既定の基準から変更中（' +
      esc(ch.join("・")) + "）</div>" +
      slider("yield_min", "配当利回り", 0, 10, 0.05, "%") +
      slider("pbr_min", "PBR 下限", 0, 3, 0.05, "倍") +
      slider("pbr_max", "PBR 上限", 0, 5, 0.05, "倍") +
      slider("operating_margin_min", "営業利益率", 0, 40, 0.5, "%") +
      '<div class="ctl"><label><span>営業利益率の集計</span></label>' +
      '<select id="mw"><option value="1">直近期</option><option value="3">3期平均</option>' +
      '<option value="10">10期平均</option></select></div>' +
      slider("equity_ratio_min", "自己資本比率", 0, 100, 1, "%") +
      slider("current_ratio_min", "流動比率", 0, 600, 10, "%") +
      slider("retained_years_min", "利益剰余金による継続年数", 0, 50, 1, "年") +
      slider("netcash_years_min", "ネットキャッシュによる継続年数", 0, 30, 0.5, "年") +
      slider("cash_ratio_min", "現金等／総資産", 0, 80, 1, "%") +
      '<button id="reset" style="width:100%">既定の基準に戻す</button>' +
      '<div class="subpanel"><h3>絞り込み<span class="note">判定には影響しません</span></h3>' +
      '<label for="dsc">配当実績の一貫性スコア（下限）</label>' +
      '<select id="dsc">' +
      '<option value="">指定しない</option>' +
      '<option value="0">0.0 以上（減配より増配が多い）</option>' +
      '<option value="0.5">0.5 以上</option>' +
      '<option value="0.8">0.8 以上（ほぼ毎期 増配か維持）</option>' +
      "</select>" +
      '<p class="note">項目3は自動判定していません。これは利用者が自分で絞り込むための' +
      "補助であり、合否には数えていません。</p></div></div>";
  }

  var timer = null;
  function bindList() {
    var view = document.getElementById("view");
    view.querySelectorAll("[data-tab]").forEach(function (b) {
      b.onclick = function () {
        state.tab = b.dataset.tab; state.page = 1;
        state.nearFail = null;           /* 別タブへ持ち越さない */
        pushState(); renderList();
      };
    });
    view.querySelectorAll("[data-nf]").forEach(function (b) {
      b.onclick = function () {
        var v = b.dataset.nf;
        state.nearFail = v === "" ? null : parseInt(v, 10);
        state.page = 1; pushState(); renderList();
      };
    });
    view.querySelectorAll("[data-sort]").forEach(function (h) {
      h.onclick = function () {
        var k = h.dataset.sort;
        if (state.sort === k) state.desc = !state.desc; else { state.sort = k; state.desc = true; }
        pushState(); renderList();
      };
    });
    view.querySelectorAll("input[type=range]").forEach(function (i) {
      i.oninput = function () {
        var k = i.dataset.key, v = parseFloat(i.value);
        document.getElementById("v_" + k).textContent = i.value +
          (k.indexOf("pbr") === 0 ? "倍" : (k.indexOf("years") >= 0 ? "年" : "%"));
        clearTimeout(timer);
        timer = setTimeout(function () {
          state.th[k] = v; state.page = 1; recompute(); pushState(); renderList();
          var el = document.getElementById("s_" + k); if (el) el.focus();
        }, 100);
      };
    });
    var mw = document.getElementById("mw");
    if (mw) {
      mw.value = String(state.th.margin_window);
      mw.onchange = function () {
        state.th.margin_window = parseInt(mw.value, 10);
        recompute(); pushState(); renderList();
      };
    }
    var dsc = document.getElementById("dsc");
    if (dsc) {
      dsc.value = state.minDsc === null ? "" : String(state.minDsc);
      dsc.onchange = function () {
        /* 表示上の絞り込みのみ。judge() は呼ばない（判定は変わらない） */
        state.minDsc = dsc.value === "" ? null : parseFloat(dsc.value);
        state.page = 1;
        pushState(); renderList();
      };
    }
    var tg = document.getElementById("tgpanel");
    if (tg) tg.onclick = function () {
      state.panel = !state.panel;
      pushState(); renderList();
      var b = document.getElementById("tgpanel"); if (b) b.focus();
    };
    ["reset", "reset2", "reset3"].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.onclick = function () {
        state.th = Object.assign({}, DEFAULTS); state.page = 1;
        recompute(); pushState(); renderList();
      };
    });
    var q = document.getElementById("q");
    if (q) q.oninput = function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        state.q = q.value; state.page = 1; renderList();
        var e = document.getElementById("q"); if (e) { e.focus(); e.setSelectionRange(e.value.length, e.value.length); }
      }, 150);
    };
    var prev = document.getElementById("prev"), next = document.getElementById("next");
    if (prev) prev.onclick = function () { if (state.page > 1) { state.page--; renderList(); } };
    if (next) next.onclick = function () { state.page++; renderList(); };
    var csv = document.getElementById("csv");
    if (csv) csv.onclick = exportCsv;
    view.querySelectorAll("[data-code]").forEach(function (tr) {
      /* 銘柄ページは物理HTMLにしたのでそちらへ遷移する。
         リンクを踏んだときはブラウザに任せる（新しいタブで開けるように）。 */
      tr.onclick = function (e) {
        if (e.target && e.target.tagName === "A") return;
        location.href = "stock/" + tr.dataset.code + ".html";
      };
    });
  }

  function exportCsv() {
    var rows = filtered();
    var lines = ["# こつこつ配当 抽出結果 " + state.data.meta.generated_at,
                 "# 項目3（配当方針）は自動判定していません。ここに出ているのは候補です。",
                 "# 使用したしきい値: " + Object.keys(state.th).map(function (k) {
                   return k + "=" + state.th[k]; }).join(" "),
                 "コード,銘柄名,業種,配当利回り(%),PBR,営業利益率(%),自己資本比率(%),流動比率(%),現金等比率(%),判定,落選項目"];
    rows.forEach(function (j) {
      var s = j.s;
      lines.push([s.c, '"' + (s.n || "").replace(/"/g, '""') + '"', '"' + (s.s || "") + '"',
        j.y === null ? "" : j.y.toFixed(2), j.pbr === null ? "" : j.pbr.toFixed(2),
        s.or === null || s.or === undefined ? "" : s.or.toFixed(1),
        s.eq === null || s.eq === undefined ? "" : s.eq.toFixed(1),
        s.cr === null || s.cr === undefined ? "" : s.cr.toFixed(0),
        s.ch === null || s.ch === undefined ? "" : s.ch.toFixed(1),
        VERDICT_LABEL[j.v], '"' + j.failed.join(" ") + '"'].join(","));
    });
    var blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "kotsukotsu_" + state.data.meta.price_date + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
  }

  /* ---------- 詳細 ---------- */
  function bar(v, th, pass, max) {
    if (v === null || v === undefined) return "";
    var m = max || Math.max(v, th) * 1.35 || 1;
    return '<div class="bar' + (pass ? "" : " fail") + '"><div class="fill" style="width:' +
      Math.max(0, Math.min(100, v / m * 100)).toFixed(1) + '%"></div>' +
      '<div class="th" style="left:' + Math.max(0, Math.min(100, th / m * 100)).toFixed(1) + '%"></div></div>';
  }

  function renderDetail(code) {
    var j = judged.filter(function (x) { return x.s.c === code; })[0];
    if (!j) { document.getElementById("view").innerHTML = '<p class="empty">銘柄が見つかりません</p>'; return; }
    var s = j.s;
    document.getElementById("view").innerHTML = '<div class="detail"><p><a href="#/">← 一覧に戻る</a></p>' +
      '<p class="empty">読み込み中…</p></div>';
    fetch("data/stocks/" + code + ".json").then(function (r) { return r.json(); })
      .then(function (d) { drawDetail(j, d); })
      .catch(function () {
        document.getElementById("view").innerHTML =
          '<div class="detail"><p><a href="#/">← 一覧に戻る</a></p><p class="empty">詳細データを読み込めませんでした。</p></div>';
      });
  }

  function drawDetail(j, d) {
    var s = j.s, th = state.th;
    var mk = { pass: "✔", fail: "✘", unjudged: "⃠", na: "⃠" };
    var conds = [];
    for (var n = 1; n <= 10; n++) {
      var c = j.r[n], meta = "", b = "";
      if (n === 1 && c.v !== null) { meta = c.v.toFixed(2) + "%（基準 " + th.yield_min + "%以上）"; b = bar(c.v, th.yield_min, c.st === "pass"); }
      else if (n === 2 && c.v !== null) meta = c.v.toFixed(2) + "倍（基準 " + th.pbr_min + "〜" + th.pbr_max + "倍）";
      else if (n === 3) meta = "自動判定できません。下の材料をご覧のうえ、ご自身でIR資料をご確認ください。";
      else if (n === 4) meta = "利益剰余金ベース " + (s.ry === null || s.ry === undefined ? "—" : s.ry.toFixed(1) + "年") +
        "（基準 " + th.retained_years_min + "年）／ネットキャッシュベース " +
        (s.nc === null || s.nc === undefined ? "—" : s.nc.toFixed(1) + "年") + "（基準 " + th.netcash_years_min + "年）";
      else if (n === 5) meta = s.ss === null || s.ss === undefined ? "有効な期数が不足しています"
        : (s.ss > 0 ? "↗ 上昇" : "↘ 下降") + " 傾き " + (s.ss * 100).toFixed(1) + "%/年";
      else if (n === 6) { if (s.fin) meta = "金融業のため適用できません";
        else if (c.v !== null && c.v !== undefined) { meta = c.v.toFixed(1) + "%（基準 " + th.operating_margin_min + "%以上）"; b = bar(c.v, th.operating_margin_min, c.st === "pass"); }
        else meta = "営業利益または売上高が取得できません"; }
      else if (n === 7) meta = (s.es === null || s.es === undefined) ? "有効な期数が不足しています"
        : "EPS " + (s.es > 0 ? "↗" : "↘") + " " + s.es.toFixed(2) + " ／ BPS " + (s.bs > 0 ? "↗" : "↘") + " " + s.bs.toFixed(2);
      else if (n === 8) { if (c.v !== null && c.v !== undefined) { meta = c.v.toFixed(1) + "%（基準 " + th.equity_ratio_min + "%以上）"; b = bar(c.v, th.equity_ratio_min, c.st === "pass", 100); } else meta = "取得できません"; }
      else if (n === 9) { if (s.fin) meta = "金融業のため適用できません";
        else if (c.v !== null && c.v !== undefined) { meta = c.v.toFixed(0) + "%（基準 " + th.current_ratio_min + "%以上）"; b = bar(c.v, th.current_ratio_min, c.st === "pass"); } else meta = "取得できません"; }
      else if (n === 10) { if (c.v !== null && c.v !== undefined) { meta = c.v.toFixed(1) + "%（基準 " + th.cash_ratio_min + "%以上）" +
        (s.chs === null || s.chs === undefined ? "" : "／傾き " + (s.chs >= 0 ? "↗" : "↘") + " " + s.chs.toFixed(2)); b = bar(c.v, th.cash_ratio_min, c.st === "pass", 100); } else meta = "取得できません"; }
      var prov = PROVISIONAL[n === 4 ? "retained_years_min" : (n === 10 ? "cash_ratio_min" : "")]
        ? '<span class="badge-prov" title="元にした考え方に具体的な数値がないため本サイトが独自に置いた暫定値です">暫定</span>' : "";
      conds.push('<div class="cond"><div class="mk mk-' + c.st + '">' + mk[c.st] + "</div><div>" +
        '<div class="lb">' + n + ". " + esc(LABELS[n]) + prov + "</div>" +
        '<div class="meta">' + esc(meta) + "</div>" + b + "</div></div>");
    }

    var years = d.years || [];
    var lbl = function (r) { return (r.fiscal_year || "").replace("-", "/"); };
    var mkpts = function (f) { return years.map(function (r) { return { label: lbl(r), value: r[f] }; }); };
    var marginPts = years.map(function (r) {
      return { label: lbl(r), value: (r.operating_income !== null && r.net_sales) ? r.operating_income / r.net_sales * 100 : null };
    });
    var ordPts = years.map(function (r) {
      return { label: lbl(r), value: (r.ordinary_income !== null && r.net_sales) ? r.ordinary_income / r.net_sales * 100 : null };
    });
    var cashPts = years.map(function (r) {
      return { label: lbl(r), value: (r.cash_equivalents !== null && r.total_assets) ? r.cash_equivalents / r.total_assets * 100 : null };
    });

    var charts = window.Chart.block("売上高", mkpts("net_sales"), { zeroBase: true, unit: "円" }) +
      window.Chart.block("営業利益率（%）", marginPts, { type: "line", digits: 1 }) +
      window.Chart.block("経常利益率（%）※営業利益が10期そろわない場合の参考", ordPts, { type: "line", digits: 1 }) +
      window.Chart.block("1株配当（円）", mkpts("dps"), { zeroBase: true, digits: 1 }) +
      window.Chart.block("自己資本比率（%）", mkpts("equity_ratio"), { type: "line", digits: 1 }) +
      window.Chart.block("EPS（円）", mkpts("eps"), { type: "line", digits: 1 }) +
      window.Chart.block("BPS（円）", mkpts("bps"), { type: "line", digits: 1 }) +
      window.Chart.block("現金等／総資産（%）", cashPts, { type: "line", digits: 1 });

    /* 株価チャート。購入検討の材料であり、判定には使っていない。
       分割調整後の終値を使うため、株式分割でチャートが飛ばない。 */
    var px = d.prices || {};
    var pxPts = function (iv) {
      var h = px[iv];
      if (!h || !h.p || !h.p.length) return null;
      return h.p.map(function (v, i) { return { label: h.d[i], value: v }; });
    };
    var mo = pxPts("monthly"), wk = pxPts("weekly");
    var priceCharts = "";
    if (mo) priceCharts += window.Chart.block("株価の推移（月次・最大10年）", mo,
                                              { type: "line", digits: 0, unit: "円" });
    if (wk) priceCharts += window.Chart.block("株価の推移（週次・直近3年）", wk,
                                              { type: "line", digits: 0, unit: "円" });

    var failbox = "";
    if (j.v === "near" && j.failed.length) {
      var n0 = j.failed[0], cc = j.r[n0];
      var need = { 1: "yield_min", 6: "operating_margin_min", 8: "equity_ratio_min",
                   9: "current_ratio_min", 10: "cash_ratio_min" }[n0];
      var gap = (cc.v !== null && cc.v !== undefined && cc.th !== undefined)
        ? "実測 " + cc.v.toFixed(2) + "（基準まで あと " + (cc.th - cc.v).toFixed(2) + "）" : "";
      failbox = '<div class="failbox"><b>✘ 満たさなかった項目：' + n0 + " " + esc(LABELS[n0]) + "</b><br>" +
        esc(gap) +
        (need && cc.v !== null && cc.v !== undefined
          ? '<br>しきい値を ' + cc.v.toFixed(2) + ' に下げると候補に入ります。 ' +
            '<button id="tryit" data-key="' + need + '" data-val="' + cc.v + '">この値で試す</button>' : "") +
        "</div>";
    }

    /* 項目3の判断材料。**判定結果ではない**。合否に数えていないことが
       画面から明らかになるよう、条件一覧とは別枠に置く。 */
    var dv = d.dividend || {};
    var tags = (dv.tags || []).map(function (t) {
      return '<span class="ptag">' + esc(t) + "</span>";
    }).join("");
    var cn = dv.counts || {};
    var scoreLine;
    if (dv.score === null || dv.score === undefined) {
      scoreLine = "配当と利益の両方がそろう期が足りないため、算出していません。";
    } else {
      var parts = [];
      if (cn.up_on_growth) parts.push("増益増配 " + cn.up_on_growth + "回");
      if (cn.hold_on_decline) parts.push("減益でも維持 " + cn.hold_on_decline + "回");
      if (cn.up_on_decline) parts.push("減益でも増配 " + cn.up_on_decline + "回");
      if (cn.hold_on_growth) parts.push("増益なのに据置 " + cn.hold_on_growth + "回");
      if (cn.cut) parts.push("減配 " + cn.cut + "回");
      scoreLine = "<b>" + dv.score.toFixed(2) + "</b>（" + dv.transitions + "期分：" +
        esc(parts.join("／") || "—") + "）";
    }
    var policyBox = dv.policy_text
      ? "<details><summary>会社が有価証券報告書に書いている配当政策の原文" +
        (dv.policy_period ? "（" + esc(dv.policy_period) + "期）" : "") +
        "</summary><p class=\"policy\">" + esc(dv.policy_text) + "</p></details>"
      : "";

    var help = '<div class="help"><h3>項目3はご自身でご確認ください</h3>' +
      '<p class="count">項目3は定性評価のため<b>合否に数えていません</b>。' +
      "以下は判定結果ではなく、ご自身が判断するための事実です。</p><ul>" +
      "<li><b>会社が示す方針</b>：" + (tags || "（本文から手がかりを検出できませんでした）") + "</li>" +
      "<li><b>配当実績の一貫性</b>：" + scoreLine + "</li>" +
      "<li>連続増配・非減配：" + (s.np === null || s.np === undefined ? "—" : s.np + "期連続で減配なし") +
      (s.dc ? "（期間中に減配あり）" : "") + "</li>" +
      "<li>配当性向：" + (s.pr === null || s.pr === undefined ? "—" : s.pr.toFixed(1) + "%") + "</li>" +
      '<li><a href="https://disclosure2.edinet-fsa.go.jp/WEEK0010.aspx" target="_blank" rel="noopener">EDINETで有価証券報告書を探す</a></li>' +
      '<li><a href="https://www.google.com/search?q=' + encodeURIComponent(s.c + " " + (s.n || "") + " IR 配当方針") +
      '" target="_blank" rel="noopener">企業のIR・配当方針を検索する</a></li></ul>' +
      policyBox + "</div>";

    var srcNote = years.some(function (r) { return r.restated; })
      ? '<p class="count">※ 一部の期は、新しい有価証券報告書で遡及修正された値を採用しています。</p>' : "";

    document.getElementById("view").innerHTML = '<div class="detail">' +
      '<p><a href="#/" id="back">← 一覧に戻る</a></p>' +
      "<h1>" + s.c + " " + esc(s.n) + ' <span class="v v-' + j.v + '">' + VERDICT_LABEL[j.v] + "</span></h1>" +
      '<p class="sub">' + esc(s.s || "") + " ｜ " + esc(s.m || "") + " ｜ 株価 " +
      (s.p === null || s.p === undefined ? "—" : s.p.toLocaleString() + "円") +
      "（" + esc(state.data.meta.price_date) + "）<br>財務データ：" + esc(s.fy || "—") + "期 " +
      (s.b === "consolidated" ? "連結" : "単体") + (s.ifrs ? "・IFRS" : "") +
      " ／ 有効期数 " + (s.nper || 0) + "期</p>" +
      failbox + '<div class="panel">' + conds.join("") + "</div>" +
      (priceCharts
        ? "<h2 style=\"font-size:1rem;margin-top:1.4rem\">株価の推移</h2>" +
          '<p class="count">分割・配当調整後の終値です。判定には使っていません。</p>' +
          '<div class="grid2">' + priceCharts + "</div>"
        : "") +
      "<h2 style=\"font-size:1rem;margin-top:1.4rem\">業績の推移</h2>" + srcNote +
      '<div class="grid2">' + charts + "</div>" + help + "</div>";

    window.Chart.bindToggles(document.getElementById("view"));
    var t = document.getElementById("tryit");
    if (t) t.onclick = function () {
      state.th[t.dataset.key] = parseFloat(t.dataset.val);
      recompute(); location.hash = "#/";
    };
  }

  /* ---------- 説明ページ ---------- */
  function renderAbout(which) {
    var th = state.th;
    var rows = [];
    for (var n = 1; n <= 10; n++) rows.push("<tr><td>" + n + "</td><td>" + esc(LABELS[n]) + "</td><td>" +
      ({1: "予想（実績）1株配当 ÷ 現在株価 ≧ " + th.yield_min + "%",
        2: "株価 ÷ BPS が " + th.pbr_min + "〜" + th.pbr_max,
        3: "<b>自動判定していません</b>（定性評価のため）",
        4: "利益剰余金 ÷ 年間配当総額 ≧ " + th.retained_years_min + "年 かつ ネットキャッシュ ÷ 年間配当総額 ≧ " + th.netcash_years_min + "年<b>【暫定基準】</b>",
        5: "直近10期の売上高の対数線形回帰の傾き > 0",
        6: "営業利益 ÷ 売上高 ≧ " + th.operating_margin_min + "%",
        7: "直近10期のEPSとBPSの回帰の傾きが両方 > 0",
        8: "自己資本 ÷ 総資産 ≧ " + th.equity_ratio_min + "%",
        9: "流動資産 ÷ 流動負債 ≧ " + th.current_ratio_min + "%",
        10: "現金等 ÷ 総資産 ≧ " + th.cash_ratio_min + "% かつ 直近5期の同比率の傾き ≧ 0<b>【暫定基準】</b>"}[n]) +
      "</td></tr>");

    var conditions = '<div class="prose"><h1>10項目の説明</h1>' +
      "<p>本サイトは、全上場銘柄の財務データに<b>10項目のチェック</b>を毎日あてはめ、" +
      "高配当かつ財務が健全な銘柄の<b>候補</b>を機械的に絞り込んでいます。" +
      "推奨銘柄の一覧ではなく、ご自身で調べるための出発点としてお使いください。</p>" +
      "<h2>10項目と本サイトの判定式</h2><table><thead><tr><th>#</th><th>チェック項目</th><th>本サイトの判定式</th></tr></thead><tbody>" +
      rows.join("") + "</tbody></table>" +
      "<h2>項目3を判定していない理由</h2><p>項目3「配当方針が明確で、配当実績に納得できる」は、" +
      "各社のIR資料や配当方針の記述を読んで人が判断するものです。決算数値からは機械的に判定できません。" +
      "そのため本サイトは、項目3を<b>合格にも不合格にも数えず</b>、結果を「合格」と断定せず<b>「候補」</b>と表記しています。" +
      "銘柄詳細ページに、連続増配年数・配当性向・IR資料へのリンクを用意しています。</p>" +
      "<h2>暫定基準について</h2><p>項目4の年数（利益剰余金10年・ネットキャッシュ3年）と項目10の水準（20%）は、" +
      "元にした考え方に具体的な数値の記載がないため<b>本サイトが独自に置いた暫定値</b>です。財務の常識から外れる水準ではありませんが、" +
      "唯一の正解というわけではありません。全銘柄の実分布を算出したうえで見直す予定です。" +
      "画面上では「暫定」バッジを付けています。しきい値は左の判定基準パネルでご自身の基準に変更できます。</p>" +
      "<h2>金融業の扱い</h2><p>銀行・証券・保険・その他金融業は、<b>本サイトの10項目では判定していません</b>。" +
      "財務の構造が一般の事業会社と大きく異なり、同じ物差しで測ると業態そのものが理由で落ちてしまうためです。" +
      "たとえば<b>銀行業の自己資本比率は中央値4.9%</b>（一般の事業会社は56.9%）で、項目8の「50%以上」は経営の良し悪しに関わらず満たしようがありません。" +
      "営業利益率や流動比率も概念が異なります。一覧から消すと混乱を招くため、<b>「判定対象外」として残し</b>、各指標の実測値は表示しています。</p>" +
      '<h2>参考にした考え方</h2><p>本サイトの10項目は、<a href="https://kobito-kabu.com/about/jouken/" target="_blank" rel="noopener">こびと株.com「こびと株の10条件」</a>' +
      "で紹介されている銘柄選びの考え方を参考に、本サイトが独自に数値化・実装したものです。" +
      "<b>本サイトはこびと株.comとは一切関係がなく、同サイトが推奨する銘柄一覧でもありません。</b>" +
      "判定に用いるしきい値や計算式は本サイトが定めたものであり、同サイトの基準と一致する保証はありません。</p></div>";

    var m = state.data.meta;
    var data = '<div class="prose"><h1>データについて</h1>' +
      "<h2>データ源</h2><table><tbody>" +
      "<tr><td>財務データ</td><td>EDINET（金融庁）の有価証券報告書。1件で5期分の「主要な経営指標等の推移」と、2期分の財務諸表本体を取得しています</td></tr>" +
      "<tr><td>銘柄一覧</td><td>日本取引所グループ 上場銘柄一覧</td></tr>" +
      "<tr><td>株価・配当</td><td>Yahoo! Finance（yfinance経由）</td></tr></tbody></table>" +
      "<h2>更新頻度と鮮度</h2><p>毎日早朝に更新しています。ただし<b>財務データは有価証券報告書が年1回しか出ないため、最大で約12か月古くなります。</b>" +
      "銘柄詳細ページに、どの決算期のデータかを表示しています。現在の状態：更新日時 " + esc(m.generated_at) +
      " ／ 株価日付 " + esc(m.price_date) + " ／ 対象 " + m.universe_count + "銘柄" +
      (m.stale_count ? " ／ <b>" + m.stale_count + "銘柄は前回の株価を流用しています</b>" : "") + "</p>" +
      "<h2>配当利回りの分子について</h2><p>会社予想の配当を無料で一括取得する手段がないため、<b>過去1年間に実際に支払われた配当の合計</b>を使っています。" +
      "取得できない場合は有価証券報告書の直近期1株配当を使います。増配・減配の予想は反映されていません。</p>" +
      "<h2>連結と単体</h2><p>連結財務諸表がある会社は連結を、連結を作らない会社は単体を使います。どちらを使ったかは詳細ページに表示しています。" +
      "なお1株配当は制度上、提出会社（単体）の値しか開示されません。</p>" +
      "<h2>免責事項</h2><p>本サイトは情報提供のみを目的としており、<b>投資勧誘・投資助言ではありません</b>。" +
      "掲載内容の正確性・完全性を保証するものではなく、本サイトの利用により生じたいかなる損害についても責任を負いません。投資判断はご自身の責任でお願いします。</p>" +
      '<p>本サイトの10項目は <a href="https://kobito-kabu.com/about/jouken/" target="_blank" rel="noopener">こびと株.com「こびと株の10条件」</a> の考え方を参考にした、本サイト独自の実装です。<b>こびと株.comとは一切関係がありません。</b></p></div>';

    document.getElementById("view").innerHTML = which === "data" ? data : conditions;
  }

  /* ---------- 状態のURL保持 ---------- */
  function pushState() {
    var p = new URLSearchParams();
    p.set("tab", state.tab); p.set("sort", state.sort); p.set("desc", state.desc ? "1" : "0");
    if (state.nearFail !== null) p.set("nf", state.nearFail);
    if (state.panel) p.set("panel", "1");
    Object.keys(DEFAULTS).forEach(function (k) {
      if (state.th[k] !== DEFAULTS[k]) p.set(k, state.th[k]);
    });
    var h = "#/?" + p.toString();
    if (location.hash !== h) history.replaceState(null, "", h);
  }

  function readState(qs) {
    var p = new URLSearchParams(qs || "");
    if (p.get("tab")) state.tab = p.get("tab");
    if (p.get("nf")) state.nearFail = parseInt(p.get("nf"), 10);
    if (p.get("sort")) state.sort = p.get("sort");
    if (p.get("desc")) state.desc = p.get("desc") === "1";
    Object.keys(DEFAULTS).forEach(function (k) {
      if (p.has(k)) state.th[k] = parseFloat(p.get(k));
    });
    /* 既定と違う基準で来た人（共有されたURL・再読込）には開いて見せる。
       閉じたままだと、件数が違う理由が画面から分からない。 */
    if (p.get("panel") === "1" || isChanged()) state.panel = true;
  }

  function renderFreshness() {
    var m = state.data.meta;
    var cls = m.status === "ok" ? "ok" : (m.status === "partial" ? "partial" : "bad");
    var label = m.status === "ok" ? "● 正常更新"
      : (m.status === "partial" ? "▲ 一部前回データ流用" : "■ 更新失敗（前回のデータを表示中）");
    var d = new Date(m.generated_at);
    document.getElementById("freshness").innerHTML =
      "<span>最終更新 " + esc(isNaN(d) ? m.generated_at : d.toLocaleString("ja-JP")) + "</span>" +
      "<span>株価 " + esc(m.price_date) + "</span>" +
      "<span>対象 " + m.universe_count.toLocaleString() + "銘柄" +
      (m.previous_universe_count ? "（前回 " + m.previous_universe_count.toLocaleString() + "）" : "") + "</span>" +
      '<span class="dot ' + cls + '">' + label + "</span>" +
      (m.stale_count ? '<span class="dot partial">' + m.stale_count + "銘柄は前回株価</span>" : "") +
      '<span><a href="#/about/data">データについて</a></span>';
  }

  function route() {
    var h = location.hash || "#/";
    /* 詳細URLに直接アクセスされた場合、判定がまだ走っていない。
       recompute() を先に呼ばないと「銘柄が見つかりません」になる。 */
    if (!judged.length) recompute();
    /* 銘柄詳細は物理HTMLへ移した。旧URLで来た人を転送する。
       SPA側にも同じ内容を描くと重複コンテンツになるため、描画はしない。 */
    var m = h.match(/^#\/stock\/(\d{4})/);
    if (m) { location.replace("stock/" + m[1] + ".html"); return; }
    if (h.indexOf("#/about/data") === 0) { renderAbout("data"); return; }
    if (h.indexOf("#/about/conditions") === 0) { renderAbout("conditions"); return; }
    var qi = h.indexOf("?");
    if (qi >= 0) readState(h.slice(qi + 1));
    recompute();
    renderList();
  }

  fetch("data/summary.json").then(function (r) {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }).then(function (d) {
    state.data = d;
    if (d.meta && d.meta.thresholds) {
      Object.keys(DEFAULTS).forEach(function (k) {
        if (d.meta.thresholds[k] !== undefined) DEFAULTS[k] = d.meta.thresholds[k];
      });
      state.th = Object.assign({}, DEFAULTS);
    }
    renderFreshness();
    window.addEventListener("hashchange", route);
    route();
    window.__kotsukotsu = { state: state, judge: judge, decide: decide,
                        get judged() { return judged; } };   /* E2Eテスト用 */
  }).catch(function (e) {
    document.getElementById("view").innerHTML =
      '<p class="empty">データを読み込めませんでした（' + esc(e.message) + "）。</p>";
  });
})();
