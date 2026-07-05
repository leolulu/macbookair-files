// 数量滑块(slider1)超档吸附：在事件捕获层改写鼠标坐标，
// 使 101~103 不稳定区在拖动过程中即时吸附(过中点 102 入 104，未过回 100)。
// rc-slider 收到的坐标已是吸附后位置，无受控回写，因此拖动中零震颤(图形软件式吸附)。
// 键盘/点击轨道等旁路由 image.py 中监听 value 的 clientside 回调兜底。
(function () {
    var SLIDER_MIN = 4;
    var SLIDER_MAX = 104;
    var ZONE_LOW = 100;
    var ZONE_MID = 102;
    var dragging = false;

    function snappedClientX(clientX) {
        var rail = document.querySelector('#slider1 .rc-slider-rail');
        if (!rail) return null;
        var rect = rail.getBoundingClientRect();
        if (rect.width <= 0) return null;
        var val = SLIDER_MIN + ((clientX - rect.left) / rect.width) * (SLIDER_MAX - SLIDER_MIN);
        if (val > ZONE_LOW && val < SLIDER_MAX) {
            var target = val >= ZONE_MID ? SLIDER_MAX : ZONE_LOW;
            return rect.left + ((target - SLIDER_MIN) / (SLIDER_MAX - SLIDER_MIN)) * rect.width;
        }
        return null;
    }

    function rewriteEvent(e) {
        var snapped = snappedClientX(e.clientX);
        if (snapped === null) return;
        var dx = snapped - e.clientX;
        Object.defineProperty(e, 'clientX', { value: snapped });
        Object.defineProperty(e, 'pageX', { value: e.pageX + dx });
    }

    document.addEventListener('mousedown', function (e) {
        if (e.target && e.target.closest && e.target.closest('#slider1')) {
            dragging = true;
            rewriteEvent(e);
        }
    }, true);

    document.addEventListener('mousemove', function (e) {
        if (dragging) rewriteEvent(e);
    }, true);

    document.addEventListener('mouseup', function () {
        dragging = false;
    }, true);
})();
