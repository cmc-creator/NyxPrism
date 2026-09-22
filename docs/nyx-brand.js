(function () {
  function makeGradient(ctx, x1, y1, x2, y2, stops) {
    var gradient = ctx.createLinearGradient(x1, y1, x2, y2);
    stops.forEach(function (stop) { gradient.addColorStop(stop[0], stop[1]); });
    return gradient;
  }

  function face(ctx, points, fill, stroke) {
    ctx.beginPath();
    points.forEach(function (point, index) {
      if (index) ctx.lineTo(point[0], point[1]);
      else ctx.moveTo(point[0], point[1]);
    });
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.3;
    ctx.stroke();
  }

  function drawPrism(canvas) {
    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = 96;
    canvas.height = 96;
    ctx.clearRect(0, 0, 96, 96);
    ctx.save();
    ctx.scale(96 / 84, 96 / 84);
    ctx.translate(3, 1);
    ctx.rotate(-.08);
    ctx.shadowColor = 'rgba(0,0,0,.48)';
    ctx.shadowBlur = 11;
    ctx.shadowOffsetY = 4;

    var top = [38, 5];
    var left = [8, 60];
    var bottom = [50, 75];
    var right = [75, 35];
    var center = [39, 24];
    var shoulder = [56, 19];

    face(ctx, [top, left, center], makeGradient(ctx, 8, 8, 42, 64, [
      [0, 'rgba(255,244,235,.98)'], [.42, 'rgba(255,161,205,.66)'], [1, 'rgba(0,200,255,.34)']
    ]), 'rgba(255,255,255,.8)');
    face(ctx, [top, center, shoulder, right], makeGradient(ctx, 35, 4, 78, 48, [
      [0, 'rgba(255,255,255,.72)'], [.34, 'rgba(112,88,255,.72)'], [.72, 'rgba(0,220,244,.58)'], [1, 'rgba(255,219,120,.5)']
    ]), 'rgba(255,255,255,.7)');
    face(ctx, [center, left, bottom], makeGradient(ctx, 13, 28, 51, 78, [
      [0, 'rgba(22,34,66,.88)'], [.48, 'rgba(8,14,28,.96)'], [1, 'rgba(0,202,255,.56)']
    ]), 'rgba(167,139,250,.5)');
    face(ctx, [center, bottom, right, shoulder], makeGradient(ctx, 37, 24, 76, 76, [
      [0, 'rgba(0,205,226,.54)'], [.52, 'rgba(124,58,237,.5)'], [1, 'rgba(255,214,118,.76)']
    ]), 'rgba(255,255,255,.62)');

    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'screen';
    ctx.strokeStyle = makeGradient(ctx, 12, 52, 68, 31, [
      [0, '#ff005c'], [.18, '#ff7a00'], [.34, '#ffe600'], [.53, '#00f56a'], [.72, '#00c8ff'], [1, '#b000ff']
    ]);
    ctx.lineWidth = 3.3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(15, 57);
    ctx.lineTo(38, 26);
    ctx.lineTo(69, 36);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,.96)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(top[0], top[1]);
    ctx.lineTo(left[0], left[1]);
    ctx.lineTo(bottom[0], bottom[1]);
    ctx.lineTo(right[0], right[1]);
    ctx.lineTo(top[0], top[1]);
    ctx.moveTo(center[0], center[1]);
    ctx.lineTo(left[0], left[1]);
    ctx.moveTo(center[0], center[1]);
    ctx.lineTo(bottom[0], bottom[1]);
    ctx.moveTo(center[0], center[1]);
    ctx.lineTo(right[0], right[1]);
    ctx.stroke();
    ctx.restore();
  }

  function renderBrandMarks() {
    document.querySelectorAll('canvas.nyx-prism-mark').forEach(drawPrism);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderBrandMarks);
  else renderBrandMarks();
})();