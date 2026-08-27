/* 自前SVG描画。外部CDNに依存しない（規制環境やオフラインでも壊れないため）。
   アクセシビリティのため、数値テーブルへ切り替えられるようにする。 */
(function (global) {
  "use strict";

  function fmt(v, digits) {
    if (v === null || v === undefined) return "—";
    var a = Math.abs(v);
    if (a >= 1e12) return (v / 1e12).toFixed(digits || 2) + "兆";
    if (a >= 1e8) return (v / 1e8).toFixed(digits || 1) + "億";
    if (a >= 1e4) return (v / 1e4).toFixed(digits || 1) + "万";
    return v.toFixed(digits === undefined ? 1 : digits);
  }

  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* points: [{label, value}]  type: 'bar' | 'line'

     軸を出すため preserveAspectRatio="none"（縦横を別倍率で引き伸ばす）をやめた。
     none のままだと SVG 内の文字まで歪んで読めなくなる。
     viewBox を実寸に近い比率にし、等倍で拡縮する。 */
  function svg(points, opts) {
    opts = opts || {};
    var W = 320, H = 132;
    var L = 38, R = 6, T = 8, B = 20;          /* 軸ラベルの余白 */
    var PW = W - L - R, PH = H - T - B;        /* 描画領域 */
    var vals = points.map(function (p) { return p.value; })
                     .filter(function (v) { return v !== null && v !== undefined; });
    if (!vals.length) return '<p class="empty">データがありません</p>';
    var max = Math.max.apply(null, vals), min = Math.min.apply(null, vals);
    if (opts.zeroBase && min > 0) min = 0;
    if (max === min) { max = min + Math.abs(min || 1) * 0.1; }
    var pad = (max - min) * 0.08;              /* 上下に余白。線が枠に貼り付かない */
    max += pad; min -= (opts.zeroBase && min >= 0) ? 0 : pad;

    var n = points.length;
    var bw = PW / n;
    var y = function (v) { return T + PH - (v - min) / (max - min) * PH; };
    var xc = function (i) { return L + bw * (i + 0.5); };
    var parts = [];
    var d1 = opts.digits === undefined ? 1 : opts.digits;

    /* --- 目盛り（横線＋縦軸ラベル） --- */
    var ticks = [max, (max + min) / 2, min];
    if (min < 0 && max > 0 && ticks.indexOf(0) < 0) ticks = [max, 0, min];
    /* 目盛り同士が近いと文字が重なって読めなくなる（0と小さな負の最小値など）。
       先に引いた目盛りと11単位以内なら描かない。 */
    var drawnY = [];
    ticks.forEach(function (t) {
      if (Math.abs(t) < 1e-9) t = 0;          /* -0 を "-0.0" と表示しない */
      var ty = y(t);
      for (var k = 0; k < drawnY.length; k++) {
        if (Math.abs(drawnY[k] - ty) < 11) return;
      }
      drawnY.push(ty);
      parts.push('<line x1="' + L + '" y1="' + ty.toFixed(1) + '" x2="' + (W - R) +
                 '" y2="' + ty.toFixed(1) + '" stroke="currentColor" stroke-width="0.5" opacity="0.15"/>');
      parts.push('<text x="' + (L - 3) + '" y="' + (ty + 3).toFixed(1) +
                 '" text-anchor="end" font-size="9" fill="currentColor" opacity="0.55">' +
                 esc(fmt(t, d1)) + "</text>");
    });
    /* 0 の線は濃くする（プラスとマイナスの境目が分かるように） */
    if (min < 0 && max > 0) {
      parts.push('<line x1="' + L + '" y1="' + y(0).toFixed(1) + '" x2="' + (W - R) +
                 '" y2="' + y(0).toFixed(1) + '" stroke="currentColor" stroke-width="0.7" opacity="0.45"/>');
    }

    /* --- 系列 --- */
    if (opts.type === "line") {
      var dd = "", started = false;
      points.forEach(function (p, i) {
        if (p.value === null || p.value === undefined) return;
        dd += (started ? "L" : "M") + xc(i).toFixed(1) + " " + y(p.value).toFixed(1) + " ";
        started = true;
      });
      parts.push('<path d="' + dd + '" fill="none" stroke="currentColor" stroke-width="1.4" opacity="0.85"/>');
      /* 点が多いと丸が潰れて線が汚くなるので、少ないときだけ打つ */
      if (n <= 24) {
        points.forEach(function (p, i) {
          if (p.value === null || p.value === undefined) return;
          parts.push('<circle cx="' + xc(i).toFixed(1) + '" cy="' + y(p.value).toFixed(1) +
                     '" r="1.4" fill="currentColor"/>');
        });
      }
    } else {
      var base = (min < 0 && max > 0) ? y(0) : y(min);
      points.forEach(function (p, i) {
        if (p.value === null || p.value === undefined) return;
        var py = y(p.value);
        parts.push('<rect x="' + (L + bw * i + bw * 0.15).toFixed(1) + '" y="' + Math.min(py, base).toFixed(1) +
                   '" width="' + Math.max(bw * 0.7, 0.6).toFixed(1) + '" height="' +
                   Math.max(Math.abs(py - base), 0.5).toFixed(1) +
                   '" fill="currentColor" opacity="' + (p.old ? "0.35" : "0.75") + '"/>');
      });
    }

    /* --- 軸線 --- */
    parts.push('<line x1="' + L + '" y1="' + T + '" x2="' + L + '" y2="' + (T + PH) +
               '" stroke="currentColor" stroke-width="0.6" opacity="0.4"/>');
    parts.push('<line x1="' + L + '" y1="' + (T + PH) + '" x2="' + (W - R) + '" y2="' + (T + PH) +
               '" stroke="currentColor" stroke-width="0.6" opacity="0.4"/>');

    /* --- 横軸ラベル。全部は入らないので最初・中央・最後だけ --- */
    var idx = n >= 5 ? [0, Math.floor((n - 1) / 2), n - 1] : [0, n - 1];
    var seen = {};
    idx.forEach(function (i, k) {
      if (seen[i]) return;
      seen[i] = 1;
      var lab = points[i] && points[i].label ? String(points[i].label) : "";
      if (!lab) return;
      var anchor = k === 0 ? "start" : (i === n - 1 ? "end" : "middle");
      var tx = k === 0 ? L : (i === n - 1 ? W - R : xc(i));
      parts.push('<text x="' + tx.toFixed(1) + '" y="' + (H - 6) +
                 '" text-anchor="' + anchor + '" font-size="9" fill="currentColor" opacity="0.55">' +
                 esc(lab) + "</text>");
    });

    return '<svg viewBox="0 0 ' + W + " " + H + '" role="img" ' +
           'style="width:100%;height:auto;display:block" aria-label="' +
           esc(opts.title || "") + 'の推移">' + parts.join("") + "</svg>";
  }

  function table(points, unit, digits) {
    var head = "", body = "";
    points.forEach(function (p) {
      head += "<th>" + esc(p.label) + "</th>";
      body += "<td>" + (p.value === null || p.value === undefined ? "—" : fmt(p.value, digits)) + "</td>";
    });
    return '<div style="overflow-x:auto"><table><thead><tr>' + head +
           "</tr></thead><tbody><tr>" + body + "</tr></tbody></table>" +
           (unit ? '<p class="count">単位: ' + esc(unit) + "</p>" : "") + "</div>";
  }

  /* グラフ1つ分のブロック。表への切替を必ず添える。 */
  var seq = 0;
  function block(title, points, opts) {
    opts = opts || {};
    var id = "chart" + (++seq);
    return '<div class="chartbox">' +
      "<h3>" + esc(title) +
      ' <button type="button" class="chart-toggle" data-target="' + id +
      '" style="float:right;font-size:.7rem;padding:.1rem .4rem">表で見る</button></h3>' +
      /* 期間は横軸に出るようになったので、下の重複表示は置かない */
      '<div id="' + id + '-svg">' + svg(points, Object.assign({ title: title }, opts)) + "</div>" +
      '<div id="' + id + '-tbl" hidden>' + table(points, opts.unit, opts.digits) + "</div>" +
      "</div>";
  }

  function bindToggles(root) {
    Array.prototype.forEach.call(root.querySelectorAll(".chart-toggle"), function (b) {
      b.addEventListener("click", function () {
        var id = b.dataset.target;
        var s = document.getElementById(id + "-svg"), t = document.getElementById(id + "-tbl");
        var toTable = !s.hidden;
        s.hidden = toTable; t.hidden = !toTable;
        b.textContent = toTable ? "グラフで見る" : "表で見る";
      });
    });
  }

  global.Chart = { svg: svg, table: table, block: block, bindToggles: bindToggles, fmt: fmt, esc: esc };
})(window);
