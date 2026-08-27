/* 銘柄ページのグラフ描画。
   HTMLには要点だけを静的に書き出し、明細（14期の財務・株価277点）は
   既存のJSONから読んでここで描く。全部HTMLにすると1ページ30KB超になり、
   3,535ページで100MBを超えるため。 */
/* 直近5期の表は狭い画面に収まらない。**最新期が右端**にあるため、
   横スクロールできる枠を右端に寄せて開く。JSが無くても手で動かせるので、
   これは補助でしかない（表そのものはHTMLに書かれている）。 */
(function () {
  "use strict";
  var w = document.querySelector(".tablewrap.fin");
  if (!w) return;
  var fit = function () { w.scrollLeft = w.scrollWidth > w.clientWidth + 1 ? w.scrollWidth : 0; };
  fit();
  window.addEventListener("resize", fit);
})();

(function () {
  "use strict";
  var el = document.getElementById("charts");
  if (!el || !window.Chart) return;
  var code = el.dataset.code;

  fetch("../data/stocks/" + code + ".json", { cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var years = d.years || [];
      var lbl = function (r) { return (r.fiscal_year || "").replace("-", "/"); };
      var pts = function (f) {
        return years.map(function (r) { return { label: lbl(r), value: r[f] }; });
      };
      var ratio = function (a, b) {
        return years.map(function (r) {
          return { label: lbl(r),
                   value: (r[a] !== null && r[b]) ? r[a] / r[b] * 100 : null };
        });
      };
      var out = "";
      var px = d.prices || {};
      var series = function (iv) {
        var h = px[iv];
        if (!h || !h.p || !h.p.length) return null;
        return h.p.map(function (v, i) { return { label: h.d[i], value: v }; });
      };
      var mo = series("monthly"), wk = series("weekly");
      if (mo || wk) {
        out += '<h3>株価</h3><p class="count">分割・配当調整後の終値です。判定には使っていません。</p><div class="grid2">';
        if (mo) out += window.Chart.block("株価（月次・最大10年）", mo, { type: "line", digits: 0, unit: "円" });
        if (wk) out += window.Chart.block("株価（週次・直近3年）", wk, { type: "line", digits: 0, unit: "円" });
        out += "</div>";
      }
      out += '<h3>業績</h3><div class="grid2">' +
        window.Chart.block("売上高", pts("net_sales"), { zeroBase: true, unit: "円" }) +
        window.Chart.block("営業利益率（%）", ratio("operating_income", "net_sales"), { type: "line", digits: 1 }) +
        window.Chart.block("1株配当（円）", pts("dps"), { zeroBase: true, digits: 1 }) +
        window.Chart.block("自己資本比率（%）", pts("equity_ratio"), { type: "line", digits: 1 }) +
        window.Chart.block("EPS（円）", pts("eps"), { type: "line", digits: 1 }) +
        window.Chart.block("BPS（円）", pts("bps"), { type: "line", digits: 1 }) +
        window.Chart.block("現金等／総資産（%）", ratio("cash_equivalents", "total_assets"), { type: "line", digits: 1 }) +
        "</div>";
      el.innerHTML = out;
      window.Chart.bindToggles(el);
    })
    .catch(function () {
      el.innerHTML = '<p class="count">グラフを読み込めませんでした。' +
        "数値は上の表をご覧ください。</p>";
    });
})();
