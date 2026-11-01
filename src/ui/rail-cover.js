/**
 * DayPlan · 右栏图片（2026-11-01 用户口径）
 *
 * 点击右栏插画 → 选本地图片 → 在弹窗里自由拖动 / 缩放 / 调高度比例 → 完成。
 *   · 替换只对当前日 / 当前周生效（键 = 日期 / 周一），随文档同步（store.getCover）。
 *   · 比例 = 高度 / 宽度：下限 = 当前显示比例（替换前那张图有多高就至少多高），
 *     上限 1:1；宽度不变，高度按比例由 CSS aspect-ratio 撑开。
 *   · 导出一张 JPEG data URL（长边 ≤1024）存进文档，避免每次渲染都带着原图。
 */
(function (root) {
  'use strict';
  if (!root.DayPlan) root.DayPlan = {};

  var M = root.DayPlan.modal;
  var S = root.DayPlan.schema;
  var el = M.el;

  var RATIO_MIN = (S && S.COVER_RATIO_MIN) || 0.1;
  var RATIO_MAX = (S && S.COVER_RATIO_MAX) || 1;
  var SRC_MAX = (S && S.COVER_SRC_MAX) || 1500000;
  var OUT_MAX_WIDTH = 1024;
  var OUT_MIN_WIDTH = 480;
  var ZOOM_MAX = 3;
  var FILE_MAX_BYTES = 30 * 1024 * 1024;

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function ratioText(ratio) {
    return '高 : 宽 = ' + ratio.toFixed(2) + ' : 1';
  }

  function create(opts) {
    opts = opts || {};
    var store = opts.store || null;
    var scope = opts.scope === 'week' ? 'week' : 'day';
    var getKey = typeof opts.getKey === 'function' ? opts.getKey : function () { return null; };
    var label = opts.label || (scope === 'week' ? '本周' : '今日');
    var railEl = opts.rail || null;
    var element = opts.element || null;

    if (!element) {
      element = el('button', { class: 'rail-cover', type: 'button' });
    }
    element.classList.add('rail-cover');
    element.setAttribute('type', 'button');
    element.setAttribute('aria-label', '更换' + label + '图片');
    element.setAttribute('title', '点击更换' + label + '图片');

    var img = element.querySelector('.rail-cover-img');
    if (!img) {
      img = el('img', { class: 'rail-cover-img', alt: '', hidden: true });
      element.appendChild(img);
    }
    img.setAttribute('draggable', 'false');

    var brand = element.querySelector('.rail-cover-brand');
    if (!brand) {
      brand = el('span', { class: 'rail-cover-brand', 'aria-hidden': 'true' });
      element.appendChild(brand);
    }
    var hint = element.querySelector('.rail-cover-hint');
    if (!hint) {
      hint = el('span', { class: 'rail-cover-hint', 'aria-hidden': 'true', text: '更换图片' });
      element.appendChild(hint);
    }

    var input = el('input', { type: 'file', accept: 'image/*', hidden: true });
    (document.body || element.parentNode || element).appendChild(input);

    var currentCover = null;
    var lastSrc = null;

    function rail() {
      return railEl || element.parentNode || null;
    }

    function readCover(key) {
      if (!store || !key) return null;
      try {
        return scope === 'week' ? store.getWeekCover(key) : store.getCover(key);
      } catch (e) {
        return null;
      }
    }

    function writeCover(key, cover) {
      if (!store || !key) return;
      if (scope === 'week') store.setWeekCover(key, cover);
      else store.setCover(key, cover);
    }

    /** 当前显示的高宽比（没有自定义图片时用于比例下限）；量不到就用 0.3 兜底 */
    function displayedRatio() {
      var w = element.clientWidth;
      var h = element.clientHeight;
      if (w > 0 && h > 0) return clamp(h / w, RATIO_MIN, RATIO_MAX);
      return 0.3;
    }

    function render() {
      var key = getKey();
      var cover = readCover(key);
      currentCover = cover;
      if (cover && cover.src) {
        if (lastSrc !== cover.src) {
          img.src = cover.src;
          lastSrc = cover.src;
        }
        img.hidden = false;
        element.classList.add('has-custom');
        element.style.setProperty('--cover-ratio', String(cover.ratio));
      } else {
        if (lastSrc !== null) {
          img.removeAttribute('src');
          lastSrc = null;
        }
        img.hidden = true;
        element.classList.remove('has-custom');
        element.style.removeProperty('--cover-ratio');
      }
      var r = rail();
      if (r && r.classList) r.classList.toggle('has-custom-cover', !!cover);
    }

    element.addEventListener('click', function () {
      if (!getKey()) return;
      input.value = '';
      input.click();
    });

    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      if (!/^image\//.test(file.type || '')) {
        M.toast('请选择图片文件');
        return;
      }
      if (file.size > FILE_MAX_BYTES) {
        M.toast('图片过大，请选择 30MB 以内的图片');
        return;
      }
      openCropper(file);
    });

    /* ---------------- 裁剪弹窗 ---------------- */

    function openCropper(file) {
      var key = getKey();
      if (!key) return;
      var url = URL.createObjectURL(file);
      var source = new Image();
      var released = false;

      function release() {
        if (released) return;
        released = true;
        URL.revokeObjectURL(url);
      }

      source.onload = function () {
        showModal(key, source, url, release);
      };
      source.onerror = function () {
        release();
        M.toast('图片读取失败，请换一张试试');
      };
      source.src = url;
    }

    function showModal(key, source, objectUrl, release) {
      var cover = readCover(key);
      var minRatio = cover && cover.ratio > 0 ? cover.ratio : displayedRatio();
      minRatio = clamp(minRatio, RATIO_MIN, RATIO_MAX);

      var view = {
        ratio: minRatio,
        zoom: 1,
        offsetX: 0,
        offsetY: 0,
        stageW: 0,
        stageH: 0,
        frameW: 0,
        frameH: 0,
        baseScale: 1
      };

      var ratioValue = el('span', { class: 'range-value', text: ratioText(view.ratio) });
      var ratioInput = el('input', {
        class: 'range', type: 'range',
        min: String(minRatio), max: String(RATIO_MAX), step: '0.01',
        value: String(view.ratio), 'aria-label': '高度比例'
      });
      var zoomValue = el('span', { class: 'range-value', text: '100%' });
      var zoomInput = el('input', {
        class: 'range', type: 'range', min: '1', max: String(ZOOM_MAX), step: '0.01',
        value: '1', 'aria-label': '缩放'
      });

      var image = el('img', {
        class: 'cover-crop-img', alt: '', draggable: 'false'
      });
      image.src = objectUrl;

      var frame = el('div', { class: 'cover-crop-frame', 'aria-hidden': 'true' });
      var stage = el('div', {
        class: 'cover-crop-stage', tabindex: '0',
        'aria-label': '裁剪区域，拖动图片调整位置'
      }, [image, frame]);

      var body = el('div', { class: 'cover-crop' }, [
        stage,
        el('p', { class: 'cover-crop-tip muted', text: '拖动图片调整位置；宽度不变，高度按比例撑开' }),
        el('div', { class: 'cover-crop-controls' }, [
          el('div', { class: 'field' }, [
            el('div', { class: 'range-head' }, [
              el('label', { class: 'field-label', text: '高度比例' }),
              ratioValue
            ]),
            ratioInput
          ]),
          el('div', { class: 'field' }, [
            el('div', { class: 'range-head' }, [
              el('label', { class: 'field-label', text: '缩放' }),
              zoomValue
            ]),
            zoomInput
          ])
        ])
      ]);

      var doneBtn = el('button', {
        class: 'btn btn-primary', type: 'button', text: '完成',
        onclick: function () { apply(); }
      });
      var cancelBtn = el('button', {
        class: 'btn btn-ghost', type: 'button', text: '取消',
        onclick: function () { modal.close('cancel'); }
      });
      var footer = [];
      if (cover) {
        footer.push(el('button', {
          class: 'btn btn-ghost', type: 'button', text: '复原',
          onclick: function () {
            try {
              writeCover(key, null);
              render();
              modal.close('reset');
            } catch (e) {
              M.toast((e && e.message) || '恢复失败');
            }
          }
        }));
      }
      footer.push(el('span', { class: 'spacer' }));
      footer.push(cancelBtn);
      footer.push(doneBtn);

      var modal = M.open({
        title: '更换' + label + '图片',
        body: body,
        footer: footer,
        wide: true,
        center: true,
        showSubmit: false,
        showCancel: false,
        onClose: function () {
          window.removeEventListener('resize', onResize);
          release();
        }
      });

      function measure() {
        view.stageW = stage.clientWidth;
        view.stageH = stage.clientHeight;
      }

      function layoutFrame() {
        var maxW = Math.max(80, view.stageW - 28);
        var maxH = Math.max(60, view.stageH - 28);
        view.frameW = Math.min(maxW, maxH / view.ratio, 460);
        view.frameH = view.frameW * view.ratio;
        frame.style.width = view.frameW + 'px';
        frame.style.height = view.frameH + 'px';
      }

      function draw() {
        if (!view.stageW) measure();
        layoutFrame();
        view.baseScale = Math.max(
          view.frameW / source.naturalWidth,
          view.frameH / source.naturalHeight
        );
        var scale = view.baseScale * view.zoom;
        var dw = source.naturalWidth * scale;
        var dh = source.naturalHeight * scale;
        var maxX = Math.max(0, (dw - view.frameW) / 2);
        var maxY = Math.max(0, (dh - view.frameH) / 2);
        view.offsetX = clamp(view.offsetX, -maxX, maxX);
        view.offsetY = clamp(view.offsetY, -maxY, maxY);
        image.style.width = dw + 'px';
        image.style.height = dh + 'px';
        image.style.left = (view.stageW / 2 + view.offsetX) + 'px';
        image.style.top = (view.stageH / 2 + view.offsetY) + 'px';
      }

      function onResize() {
        measure();
        draw();
      }

      ratioInput.addEventListener('input', function () {
        var next = Number(ratioInput.value);
        if (!isFinite(next)) return;
        view.ratio = clamp(next, minRatio, RATIO_MAX);
        ratioValue.textContent = ratioText(view.ratio);
        draw();
      });

      zoomInput.addEventListener('input', function () {
        var next = Number(zoomInput.value);
        if (!isFinite(next)) return;
        view.zoom = clamp(next, 1, ZOOM_MAX);
        zoomValue.textContent = Math.round(view.zoom * 100) + '%';
        draw();
      });

      var dragging = false;
      var lastX = 0;
      var lastY = 0;
      stage.addEventListener('pointerdown', function (e) {
        if (e.button !== undefined && e.button !== 0) return;
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        try { stage.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器忽略 */ }
        e.preventDefault();
      });
      stage.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        view.offsetX += e.clientX - lastX;
        view.offsetY += e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        draw();
      });
      function endDrag() { dragging = false; }
      stage.addEventListener('pointerup', endDrag);
      stage.addEventListener('pointercancel', endDrag);
      stage.addEventListener('lostpointercapture', endDrag);

      /** 把裁剪框里的画面画到画布，导出 JPEG data URL（超长时降质 / 降分辨率） */
      function exportDataUrl() {
        var scale = view.baseScale * view.zoom;
        var cropW = view.frameW / scale;
        var cropH = view.frameH / scale;
        var centerX = source.naturalWidth / 2 - view.offsetX / scale;
        var centerY = source.naturalHeight / 2 - view.offsetY / scale;
        var sx = clamp(centerX - cropW / 2, 0, Math.max(0, source.naturalWidth - cropW));
        var sy = clamp(centerY - cropH / 2, 0, Math.max(0, source.naturalHeight - cropH));

        var outW = clamp(Math.round(cropW), OUT_MIN_WIDTH, OUT_MAX_WIDTH);
        var canvas = document.createElement('canvas');
        var ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('无法创建画布');
        var data = '';
        var shrink = 1;
        for (var attempt = 0; attempt < 4; attempt += 1) {
          canvas.width = Math.max(1, Math.round(outW * shrink));
          canvas.height = Math.max(1, Math.round(canvas.width * view.ratio));
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(source, sx, sy, cropW, cropH, 0, 0, canvas.width, canvas.height);
          var quality = attempt === 0 ? 0.85 : (attempt === 1 ? 0.72 : 0.6);
          data = canvas.toDataURL('image/jpeg', quality);
          if (data.length <= SRC_MAX) return data;
          shrink *= 0.75;
        }
        if (data.length > SRC_MAX) throw new Error('图片压缩后仍然过大');
        return data;
      }

      function apply() {
        doneBtn.disabled = true;
        try {
          var src = exportDataUrl();
          writeCover(key, { src: src, ratio: view.ratio });
          render();
          modal.close('confirm');
        } catch (e) {
          doneBtn.disabled = false;
          M.toast((e && e.message) || '保存图片失败');
        }
      }

      window.addEventListener('resize', onResize);
      requestAnimationFrame(function () {
        measure();
        draw();
      });
    }

    return { element: element, render: render };
  }

  root.DayPlan.railCover = { create: create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
